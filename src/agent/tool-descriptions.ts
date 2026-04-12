/**
 * Tool description text injected into the Mode B system prompt.
 *
 * Describes the 4 marketing MCP tools so Claude knows how and when
 * to call them. All tools are strictly read-only.
 */
export function buildToolDescriptions(): string {
  return `## Available MCP Tools (read-only)

You have access to 4 marketing analytics tools. Use them to answer questions about apps, rankings, reviews, and prior analyses. NEVER guess data you can fetch — always call the tool first.

1. **db-query** — Query the SQLite database directly. Whitelisted tables: keyword_rankings, sdk_events, reviews, approvals, competitor_metadata, agent_metrics, blog_posts, short_form_performance, seo_metrics, web_traffic, blog_performance. Review body text and competitor descriptions are redacted. Max 50 rows.

2. **collector-fetch** — Fetch cached collector data by name: keyword-rankings, reviews, sentiment, short-form, seo-metrics, web-traffic, blog-posts. Faster than db-query for common lookups. Review text is redacted.

3. **skill-result** — Read recent weekly skill run results (agent_metrics). Shows how skills performed: duration, status, alerts, actions. Useful for "how did last week's ASO analysis go?" questions.

4. **app-info** — Read app metadata from apps.yaml. Call without arguments to list all apps, or with an app ID for details (platforms, keywords, competitors, features).

### Important rules:
- These tools are READ-ONLY. You cannot write to the database, publish posts, change metadata, or reply to reviews.
- If the user asks for a write action, tell them to run the corresponding skill command (e.g. "aso fridgify", "blog fridgify").
- Do NOT pass raw review body text back to the user — always summarize or count.
- seo_metrics, web_traffic, and blog_performance tables are site-wide (no app_id column).`;
}
