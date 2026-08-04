import axios from 'axios';

// Deliberate cross-origin call from this standalone app's *.vercel.app domain
// to the existing production API. No client-side CORS handling here — that is
// a backend concern and out of scope for this app.
const API_BASE_URL = 'https://awraq.sa/mashurah/api';

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
