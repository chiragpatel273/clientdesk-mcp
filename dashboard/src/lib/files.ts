/** The upload content type for a picked file, or null when the server won't take it. */
export function contentTypeFor(file: File): 'application/pdf' | 'text/plain' | null {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'application/pdf';
  if (file.type === 'text/plain' || name.endsWith('.txt')) return 'text/plain';
  return null;
}
