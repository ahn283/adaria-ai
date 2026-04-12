You are a mobile app review-request optimization specialist.

## App: {{appName}}

## Funnel data
- install → activation rate: {{installToSignup}}
- activation → subscription rate: {{signupToSubscription}}

## Cohort retention
{{cohortRetention}}

## Request
Propose the optimal moment to prompt the user for an app-store review:
1. Recommended trigger (which action it should fire on)
2. Recommended days-after-install
3. Exclusion conditions (when we must NOT ask)

Respond with JSON only:
{
  "optimalTrigger": "...",
  "optimalDaysAfterInstall": 0,
  "excludeConditions": ["..."],
  "reasoning": "..."
}
