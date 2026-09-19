type ScrollViewport = {
  scrollTop: number;
  clientTop: number;
  clientHeight: number;
  getBoundingClientRect(): { top: number };
};

type QuestionElement = {
  style: { minHeight: string };
  getBoundingClientRect(): { top: number };
};

/** Consume one explicit submission, never response updates or panel reopening. */
export function createQuestionScrollAnchor() {
  let pendingId: string | null = null;
  let previousQuestion: QuestionElement | null = null;
  return {
    get pendingId() { return pendingId; },
    request(id: string) { pendingId = id; },
    cancel() { pendingId = null; },
    apply(id: string, viewport: ScrollViewport, question: QuestionElement, minimumHeight = viewport.clientHeight) {
      if (id !== pendingId || viewport.clientHeight <= 0) return false;
      pendingId = null;
      if (previousQuestion && previousQuestion !== question) previousQuestion.style.minHeight = '';
      // Keep room below a short/loading answer so its prompt can reach the top.
      // Retain that room on completion; collapsing it would move the reader.
      const height = Number.isFinite(minimumHeight) ? Math.max(viewport.clientHeight, minimumHeight) : viewport.clientHeight;
      question.style.minHeight = `${Math.ceil(height)}px`;
      previousQuestion = question;
      const top = viewport.scrollTop + question.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop;
      viewport.scrollTop = Math.max(0, top);
      return true;
    },
  };
}
