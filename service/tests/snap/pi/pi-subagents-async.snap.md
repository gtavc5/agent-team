## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Delegate an async sample."
## 3 agent done ctx 7/1000
  text "Async sample scheduled."
  thinking "Consider the example."
  tool subagent "**subagent** ```json { \"agent\": \"reviewer\", \"task\": \"Review the sample.\", \"async\": true } ```" → "Child scheduled." 5ms
  card  completed 55ms "Review the sample."
    thinking "Child reasoning."
    text "Child evidence."
    summary "Child complete."
## 4 agent done ctx 7/1000
  text "Async sample complete."
  notice:wakeup "Pi carried on"
