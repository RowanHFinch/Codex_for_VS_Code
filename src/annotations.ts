export type ResponseAnnotation = {
  id: string;
  itemId: string;
  turnId: string;
  text: string;
  comment: string;
  start: number;
  end: number;
};
export function validAnnotation(value: unknown): value is ResponseAnnotation {
  if (!value || typeof value !== 'object') return false;
  const a = value as ResponseAnnotation;
  return (
    ['id', 'itemId', 'turnId'].every(
      key =>
        typeof a[key as keyof ResponseAnnotation] === 'string' &&
        String(a[key as keyof ResponseAnnotation]).length > 0 &&
        String(a[key as keyof ResponseAnnotation]).length <= 200,
    ) &&
    typeof a.text === 'string' &&
    !!a.text.trim() &&
    a.text.length <= 8000 &&
    typeof a.comment === 'string' &&
    a.comment.length <= 2000 &&
    Number.isInteger(a.start) &&
    Number.isInteger(a.end) &&
    a.start >= 0 &&
    a.end > a.start &&
    a.end <= 1000000
  );
}
const marker = '\n\n[Response annotations: quoted assistant text with optional user comments]\n';
export function annotationContext(annotations: ResponseAnnotation[]) {
  return annotations.length ? marker + JSON.stringify(annotations) : '';
}
export function splitAnnotations(text: string) {
  const index = text.lastIndexOf(marker);
  if (index >= 0) {
    try {
      const annotations: unknown = JSON.parse(text.slice(index + marker.length));
      if (Array.isArray(annotations) && annotations.length <= 10 && annotations.every(validAnnotation))
        return { text: text.slice(0, index), annotations: annotations as ResponseAnnotation[] };
    } catch {
      /* Ordinary user text remains untouched. */
    }
  }
  return { text, annotations: [] as ResponseAnnotation[] };
}
