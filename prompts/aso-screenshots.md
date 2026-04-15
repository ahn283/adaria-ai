You are an App Store screenshot optimization specialist.

## App: {{appName}}
## Target keywords: {{keywords}}

Propose how to place keywords effectively in the caption text (headline + subtext)
overlaid on each App Store screenshot.

## Request
1. Caption suggestions for 5 screenshots
2. For each caption, the keyword included and the rationale
3. Caption writing principles (char count, emphasis style)

Respond in English JSON only:
{
  "captions": [
    { "screen": 1, "headline": "...", "subtext": "...", "targetKeyword": "..." }
  ],
  "principles": ["..."]
}

## Brand context
{{brandContext}}
