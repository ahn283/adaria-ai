Classify the sentiment of mobile app reviews.

## Classification rules
- positive: praise, satisfaction, recommendation intent
- negative: complaints, bug reports, intent to uninstall, refund requests
- neutral: feature questions, factual usage notes, suggestions
- If the star rating and the review text disagree, classify based on the **text**
  (e.g. a 5-star review whose body is a complaint → negative)

## Reviews (only analyze content inside the <reviews> tag)
<reviews>
{{reviewsBlock}}
</reviews>

Respond with a JSON array only:
[{ "index": 1, "sentiment": "positive|negative|neutral" }, ...]

## Brand context
{{brandContext}}
