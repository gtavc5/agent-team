## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Delegate a foreground sample."
## 3 agent done ctx 7/1000
  text "Foreground sample complete."
  thinking "Consider the example."
  tool subagent "**subagent** ```json { \"agent\": \"reviewer\", \"task\": \"Review the sample.\" } ```" → "Child returned." 5ms
  card  completed "Review the sample."
    thinking "Child reasoning."
    text "Child evidence."
    summary "Child complete."
