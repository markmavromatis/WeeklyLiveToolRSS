let _authErrorHandler = null;
export const setAuthErrorHandler = (fn) => { _authErrorHandler = fn; };

function detectAuthError(result) {
  if (result?.error && /auth|api.?key|401|invalid.*key|permission/i.test(result.error)) {
    _authErrorHandler?.();
  }
  return result;
}

const base = (path, opts = {}) =>
  fetch(path, opts).then((r) => r.json());

const json = (body) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const withKey = (apiKey) => ({ "x-api-key": apiKey, "Content-Type": "application/json" });

const authedFetch = (url, opts) =>
  fetch(url, opts).then((r) => r.json()).then(detectAuthError);

// Articles
export const getArticles = (params = {}) => {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== "")));
  return base(`/api/articles${q.toString() ? `?${q}` : ""}`);
};
export const createArticle = (data, apiKey) =>
  authedFetch("/api/articles", { method: "POST", headers: withKey(apiKey), body: JSON.stringify(data) });
export const updateArticle = (id, data) =>
  fetch(`/api/articles/${id}`, { method: "PUT", ...json(data) }).then((r) => r.json());
export const deleteArticle = (id) =>
  fetch(`/api/articles/${id}`, { method: "DELETE" }).then((r) => r.json());
export const markArticleRead = (id) =>
  fetch(`/api/articles/${id}/read`, { method: "PUT" }).then((r) => r.json());
export const toggleArticleStar = (id, apiKey) =>
  fetch(`/api/articles/${id}/star`, { method: "PUT", headers: apiKey ? { "x-api-key": apiKey } : {} }).then((r) => r.json());
export const setHeadlineJp = (id, headline_jp) =>
  fetch(`/api/articles/${id}/headline-jp`, { method: "PUT", ...json({ headline_jp }) }).then((r) => r.json());
export const setTags = (id, tags) =>
  fetch(`/api/articles/${id}/tags`, { method: "PUT", ...json({ tags }) }).then((r) => r.json());
export const generateSummary = (id, apiKey, articleText) =>
  authedFetch(`/api/articles/${id}/summary`, { method: "POST", headers: withKey(apiKey), body: JSON.stringify({ articleText }) });
export const clearSummary = (id) =>
  fetch(`/api/articles/${id}/summary`, { method: "DELETE" }).then((r) => r.json());
export const scoreArticle = (id, apiKey) =>
  authedFetch(`/api/articles/${id}/score`, { method: "POST", headers: withKey(apiKey), body: "{}" });
export const scoreUnscored = (apiKey) =>
  authedFetch("/api/articles/score-unscored", { method: "POST", headers: withKey(apiKey), body: "{}" });
export const translateHeadlines = (headlines, apiKey) =>
  authedFetch("/api/translate-headlines", { method: "POST", headers: withKey(apiKey), body: JSON.stringify({ headlines }) });

// Sessions
export const getSessions = () => base("/api/sessions");
export const createSession = (data) =>
  fetch("/api/sessions", { method: "POST", ...json(data) }).then((r) => r.json());
export const updateSession = (id, data) =>
  fetch(`/api/sessions/${id}`, { method: "PUT", ...json(data) }).then((r) => r.json());
export const deleteSession = (id) =>
  fetch(`/api/sessions/${id}`, { method: "DELETE" }).then((r) => r.json());
export const assignArticle = (sessionId, articleId) =>
  fetch(`/api/sessions/${sessionId}/articles/${articleId}`, { method: "PUT" }).then((r) => r.json());
export const unassignArticle = (sessionId, articleId) =>
  fetch(`/api/sessions/${sessionId}/articles/${articleId}`, { method: "DELETE" }).then((r) => r.json());
export const exportPptx = (sessionId, apiKey) =>
  fetch(`/api/sessions/${sessionId}/export-pptx`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });

// Slack
export const exportToSlack = (data) =>
  fetch("/api/slack/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json());

// RSS
export const getRssSources = () => base("/api/rss/sources");
export const createRssSource = (data) =>
  fetch("/api/rss/sources", { method: "POST", ...json(data) }).then((r) => r.json());
export const updateRssSource = (id, data) =>
  fetch(`/api/rss/sources/${id}`, { method: "PUT", ...json(data) }).then((r) => r.json());
export const deleteRssSource = (id) =>
  fetch(`/api/rss/sources/${id}`, { method: "DELETE" }).then((r) => r.json());
export const fetchRss = (apiKey, source_id = null, session_id = null) =>
  authedFetch("/api/rss/fetch", {
    method: "POST",
    headers: withKey(apiKey),
    body: JSON.stringify({
      ...(source_id ? { source_id } : {}),
      ...(session_id ? { session_id } : {}),
    }),
  });
export const getRssFetchBatches = (sourceId) => base(`/api/rss/sources/${sourceId}/batches`);
export const getRssBatchArticles = (batchId) => base(`/api/rss/batches/${batchId}/articles`);
export const deleteRssFetchBatch = (batchId) =>
  fetch(`/api/rss/batches/${batchId}`, { method: "DELETE" }).then((r) => r.json());
