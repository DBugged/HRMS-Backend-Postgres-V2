// The app has no existing "this backend's own public origin" env var — the
// frontend knows the API's origin as NEXT_PUBLIC_API_URL, but that's a
// frontend-only build-time var, invisible to backend-v2 at runtime. This is
// the server-side counterpart, needed anywhere the backend builds an
// absolute URL that has to resolve from OUTSIDE this process — an email
// client fetching an <img src>, for instance, where a relative
// /files/<token> path (fine for the frontend, which resolves it against
// its own API_BASE_URL via resolveFileUrl) means nothing.
export function backendPublicUrl(): string {
  return process.env.BACKEND_PUBLIC_URL || 'http://localhost:4000';
}
