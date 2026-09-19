'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, ClipboardList, LoaderCircle, Plus, RefreshCw, Wrench } from 'lucide-react';
import type { Dashboard, Detail, WorkOrder } from '@/lib/types';
import { componentLabel, number, request, time } from '@/lib/utils';
import { ComponentGlyph, EmptyState, Note, Panel, StatusBadge } from '@/components/ui';

const orderLabel=(id:string)=>`WO-${id.slice(0,8).toUpperCase()}`;

type Filter = 'all' | WorkOrder['status'];
type OrdersState = { dataset: string; items: WorkOrder[]; error: string };
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All orders' }, { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In progress' }, { key: 'completed', label: 'Completed' },
];
const severityOrder = { critical: 0, warning: 1, unknown: 2, healthy: 3 };

export default function Maintenance({ dashboard, detail, selectedTrain, selectedComponent, onSelect, notify }: {
  dashboard: Dashboard;
  detail?: Detail | null;
  selectedTrain: string;
  selectedComponent: string;
  onSelect: (train: string, component: string) => void;
  notify: (message: string) => void;
}) {
  const datasetId = dashboard.dataset.id;
  const [ordersState, setOrdersState] = useState<OrdersState>({ dataset: '', items: [], error: '' });
  const [filter, setFilter] = useState<Filter>('all');
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState('');
  const [mutationError, setMutationError] = useState('');
  const mutationLock = useRef(false);
  const currentDataset = useRef(datasetId);
  const orders = ordersState.dataset === datasetId ? ordersState.items : [];
  const loading = ordersState.dataset !== datasetId || refreshing;
  const loadError = ordersState.dataset === datasetId ? ordersState.error : '';

  useEffect(() => {
    currentDataset.current = datasetId;
    const controller = new AbortController();
    request<{ orders: WorkOrder[] }>(`/api/orders?dataset_id=${encodeURIComponent(datasetId)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setOrdersState({ dataset: datasetId, items: result.orders, error: '' }); setRefreshing(false); } })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setOrdersState(previous => ({ dataset: datasetId, items: previous.dataset === datasetId ? previous.items : [], error: cause instanceof Error ? cause.message : 'Could not load work orders.' }));
          setRefreshing(false);
        }
      });
    return () => controller.abort();
  }, [datasetId, refresh]);

  const queue = useMemo(() => dashboard.components
    .filter(component => component.status === 'critical' || component.status === 'warning')
    .sort((a, b) => severityOrder[a.status] - severityOrder[b.status] || (b.risk ?? -1) - (a.risk ?? -1)), [dashboard.components]);
  const selected = dashboard.components.find(component => component.train_id === selectedTrain && component.component === selectedComponent);
  const selectedDetail = detail?.dataset_id === datasetId && detail.train_id === selectedTrain && detail.component === selectedComponent ? detail : null;
  const actionable = !!selectedDetail && (selectedDetail.status === 'critical' || selectedDetail.status === 'warning');
  const existing = orders.find(order => order.train_id === selectedTrain && order.component === selectedComponent && order.status !== 'completed');
  const filtered = orders.filter(order => filter === 'all' || order.status === filter);

  async function reloadOrders(id: string) {
    const result = await request<{ orders: WorkOrder[] }>(`/api/orders?dataset_id=${encodeURIComponent(id)}`);
    if (currentDataset.current === id) setOrdersState({ dataset: id, items: result.orders, error: '' });
  }

  function retainSavedOrder(order: WorkOrder) {
    if (currentDataset.current !== order.dataset_id) return;
    setOrdersState(previous => ({
      dataset: order.dataset_id,
      items: [order, ...(previous.dataset === order.dataset_id ? previous.items.filter(item => item.id !== order.id) : [])],
      error: '',
    }));
  }

  async function createOrder() {
    if (!selected || !actionable || existing || mutationLock.current || loading || loadError) return;
    mutationLock.current = true;
    setPending('create');
    setMutationError('');
    try {
      const order = await request<WorkOrder>('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_id: datasetId, train_id: selected.train_id, component: selected.component }),
      });
      retainSavedOrder(order);
      notify(`Work order ${orderLabel(order.id)} created for ${order.train_id}.`);
      try { await reloadOrders(datasetId); }
      catch { setMutationError('The work order was saved, but the list could not refresh. Refresh orders to see it.'); }
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : 'Could not create the work order. Please try again.');
    } finally { mutationLock.current = false; setPending(''); }
  }

  async function updateOrder(order: WorkOrder, status: WorkOrder['status']) {
    if (mutationLock.current || order.status === status) return;
    mutationLock.current = true;
    setPending(order.id);
    setMutationError('');
    try {
      const updated = await request<WorkOrder>(`/api/orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      retainSavedOrder(updated);
      notify(`Work order ${orderLabel(order.id)} marked ${status.replace('_', ' ')}.`);
      try { await reloadOrders(datasetId); }
      catch { setMutationError('The status was saved, but the list could not refresh. Refresh orders to see the update.'); }
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : 'Could not update the status. Please try again.');
    } finally { mutationLock.current = false; setPending(''); }
  }

  return <div className="screen maintenance-screen">
    <div className="maintenance-layout">
      <Panel title="Intervention queue" eyebrow="CURRENT FINDINGS" className="maintenance-queue"
        action={<span className="count-pill">{queue.length}</span>}>
        {queue.length === 0 ? <EmptyState title="No intervention flags" icon={<CheckCircle2 size={27}/>}>There are no warning or critical components in this dataset. Components without evidence still need data review.</EmptyState>
          : <div className="queue-list">{queue.map(finding => {
            const active = finding.train_id === selectedTrain && finding.component === selectedComponent;
            const hasOrder = orders.some(order => order.train_id === finding.train_id && order.component === finding.component && order.status !== 'completed');
            return <button type="button" key={`${finding.train_id}:${finding.component}`}
              className={`queue-card ${active ? 'selected' : ''}`} aria-pressed={active}
              onClick={() => onSelect(finding.train_id, finding.component)}>
              <div className="queue-card-top"><span className="component-icon"><ComponentGlyph component={finding.component}/></span><strong>{finding.train_id}</strong><StatusBadge status={finding.status} compact/></div>
              <div className="queue-component" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>{componentLabel[finding.component] ?? finding.component}<ArrowUpRight size={15}/></div>
              <p>{finding.title}</p>
              <div className="queue-card-bottom"><span>{number(finding.anomaly_count)} anomalous observations</span>{hasOrder && <span className="order-linked"><ClipboardList size={12}/> Order active</span>}</div>
            </button>;
          })}</div>}
      </Panel>
      <Panel title="Engineering handoff" eyebrow="SELECTED COMPONENT" className="maintenance-handoff">
        {selected ? <>
          <div className="handoff-heading"><span className="handoff-icon"><ComponentGlyph component={selected.component} size={25}/></span><div><h3>{selected.train_id}</h3><span>{componentLabel[selected.component] ?? selected.component}</span></div><StatusBadge status={selected.status}/></div>
          <h3 className="handoff-title" style={{ margin: '18px 22px 0' }}>{selected.title}</h3>
          <p className="handoff-summary">{selected.summary}</p>
          <div className="handoff-evidence">
            <div><span className="form-label">ANOMALOUS OBSERVATIONS</span><strong>{number(selected.anomaly_count)} <small>/ {number(selected.observations)}</small></strong></div>
            <div><span className="form-label">LATEST DETECTED ANOMALY</span><strong>{selected.latest_anomaly ? `${time(selected.latest_anomaly, true)} UTC` : 'Not observed'}</strong></div>
          </div>
          {selectedDetail ? <div style={{ margin: '18px 22px 0', fontSize: 12, lineHeight: 1.8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}><span className={`priority-badge ${selectedDetail.explanation.priority.toLowerCase()}`}>{selectedDetail.explanation.priority}</span><span>{selectedDetail.explanation.timeframe}</span></div>
            <div className="form-label">POSSIBLE CAUSE</div>
            <p>{selectedDetail.explanation.possible_cause}</p>
            <div className="form-label" style={{ marginTop: 14 }}>RECOMMENDED ACTION</div>
            <p>{selectedDetail.explanation.recommendation}</p>
            {selectedDetail.explanation.actions.length > 0 && <ol style={{ paddingLeft: 18, color: 'var(--muted)', margin: '8px 0 0' }}>{selectedDetail.explanation.actions.map((action, index) => <li key={index} style={{ marginBottom: 5 }}>{action}</li>)}</ol>}
          </div> : <div className="loading-state" role="status"><LoaderCircle size={18} className="spin"/>Loading this component’s advisory…</div>}
          <Note>The work order takes its issue, priority, and recommended action from the selected component’s evidence. A flag indicates an anomaly; engineering inspection establishes the cause.</Note>
          <div className="handoff-action">
            {existing ? <div className="existing-order"><CheckCircle2 size={18}/><span>Active order <strong>{orderLabel(existing.id)}</strong> · {existing.status.replace('_', ' ')}</span></div>
              : <button type="button" className="btn btn-primary" disabled={!actionable || !!pending || loading || !!loadError} onClick={createOrder}>
                {pending === 'create' ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>}{pending === 'create' ? 'Creating order…' : 'Create work order'}
              </button>}
            {selectedDetail && !actionable && <span className="muted">Select a warning or critical finding to create an intervention order.</span>}
          </div>
        </> : <EmptyState title="Select a component" icon={<Wrench size={27}/>}>Choose a finding from the intervention queue to review its evidence and create a work order.</EmptyState>}
      </Panel>
    </div>
    <Panel title="Work orders" eyebrow="LOCAL ENGINEERING REGISTER" className="work-orders-panel"
      action={<button type="button" className="btn btn-secondary btn-small" disabled={loading || !!pending} onClick={() => { setRefreshing(true); setRefresh(value => value + 1); }}><RefreshCw size={14} className={loading ? 'spin' : ''}/> Refresh</button>}>
      <div className="orders-toolbar"><div className="segmented-control" role="group" aria-label="Filter work orders">
        {FILTERS.map(item => <button type="button" key={item.key} className={filter === item.key ? 'active' : ''} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span style={{ marginLeft: 6 }}>{orders.filter(order => item.key === 'all' || order.status === item.key).length}</span></button>)}
      </div><span className="muted">{dashboard.dataset.name}</span></div>
      {(loadError || mutationError) && <div className="error-banner" role="alert">{loadError || mutationError}</div>}
      {loading && <div className="loading-state" role="status"><LoaderCircle size={20} className="spin"/> Loading work orders…</div>}
      {!loading && !loadError && filtered.length === 0 && <EmptyState title={filter === 'all' ? 'No work orders yet' : `No ${filter.replace('_', ' ')} orders`} icon={<ClipboardList size={27}/>}>{filter === 'all' ? 'Review a flagged component above to create an evidence-backed work order.' : 'Use another filter to see the remaining orders.'}</EmptyState>}
      {!loading && filtered.length > 0 && <div className="table-scroll"><table className="data-table orders-table">
        <thead><tr><th scope="col">Order / component</th><th scope="col">Issue & recommended action</th><th scope="col">Priority</th><th scope="col">Created · UTC</th><th scope="col">Status</th></tr></thead>
        <tbody>{filtered.map(order => <tr key={order.id}>
          <td><button type="button" className="order-id text-link" onClick={() => onSelect(order.train_id, order.component)} title={order.id}>{orderLabel(order.id)}<ArrowUpRight size={12}/></button><strong style={{ display: 'block', marginTop: 4 }}>{order.train_id}</strong><span className="table-subtext">{componentLabel[order.component] ?? order.component}</span></td>
          <td><div className="order-issue">{order.issue}</div><p className="order-action">{order.action}</p></td>
          <td><span className={`priority-badge ${order.priority.toLowerCase()}`}>{order.priority}</span></td>
          <td className="nowrap">{time(order.created_at, true)}</td>
          <td><div className="order-status-control"><select value={order.status} className="status-select" aria-label={`Status for work order ${orderLabel(order.id)}`} disabled={!!pending || order.status === 'completed'}
            onChange={event => updateOrder(order, event.target.value as WorkOrder['status'])}>
            {order.status === 'open' && <option value="open">Open</option>}{order.status !== 'completed' && <option value="in_progress">In progress</option>}<option value="completed">Completed</option>
          </select>{pending === order.id && <LoaderCircle size={14} className="spin" aria-label="Saving status"/>}</div></td>
        </tr>)}</tbody>
      </table></div>}
      <Note>Order status tracks work, not sensor health. Completing or acknowledging maintenance never changes the measured fleet status.</Note>
    </Panel>
  </div>;
}
