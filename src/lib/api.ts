import axios from 'axios';

// Deliberate cross-origin call from this standalone app's own domain to the
// platform API. No client-side CORS handling here — that is a backend concern
// and out of scope for this app. Defaults to prod; VITE_API_BASE_URL lets a
// separately-built dev deployment point at the dev API instead.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://awraq.sa/mashurah/api';

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

export function getApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (error.response?.status === 429) {
      const secs = data?.retryAfter;
      return secs
        ? `تجاوزت الحد المسموح. يرجى المحاولة بعد ${secs} ثانية`
        : 'تجاوزت عدد المحاولات المسموحة. يرجى الانتظار';
    }
    return data?.message || 'حدث خطأ غير متوقع. يرجى المحاولة مجدداً';
  }
  if (error instanceof Error) return error.message;
  return 'حدث خطأ غير متوقع. يرجى المحاولة مجدداً';
}
