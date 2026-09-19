import type { Status } from './types';
export const colors:Record<Status,string> = {healthy:'#62dbb4',warning:'#f5bf70',critical:'#f27a88',unknown:'#8c9fae'};
export const statusLabel:Record<Status,string> = {healthy:'Healthy',warning:'Warning',critical:'Critical',unknown:'No evidence'};
export const componentLabel:Record<string,string> = {bogies:'Bogie assembly',doors:'Door systems',brakes:'Braking system',motors:'Traction motors',general:'Sensor group'};
export const shortComponent:Record<string,string> = {bogies:'Bogies',doors:'Doors',brakes:'Brakes',motors:'Motors',general:'General'};
export function number(value:number|null|undefined,digits=0){ return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-GB',{maximumFractionDigits:digits}); }
export function time(value:string|null|undefined,full=false){if(!value)return 'Not available'; const date=new Date(value);return Number.isNaN(+date) ? value : date.toLocaleString('en-GB',{...(full?{day:'2-digit',month:'short'}:{}),hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});}
export async function request<T>(url:string,init?:RequestInit):Promise<T>{const r=await fetch(url,init);if(!r.ok){let message=`Request failed (${r.status})`;try {const body=await r.json();message=typeof body.detail==='string'?body.detail:message;}catch{}throw new Error(message);}return r.json();}
