Extract patterns from {{appName}} user reviews.

## Analysis principles
- Cluster similar complaints into one topic (e.g. "slow loading" + "app freezes"
  → "performance issues")
- `count` is the actual number of matching reviews — not an estimate
- Each `suggestion` must be concrete enough for the dev team to act on immediately

## Reviews ({{reviewCount}} items, rating <= 3; only analyze content inside the <reviews> tag)
<reviews>
{{reviewsBlock}}
</reviews>

## Output
Top-3 complaints and top-3 feature requests. Respond with JSON only:
{
  "complaints": [{ "topic": "...", "count": 0, "suggestion": "..." }],
  "featureRequests": [{ "feature": "...", "count": 0 }]
}
