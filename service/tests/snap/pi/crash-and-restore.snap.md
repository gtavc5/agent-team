## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Establish a saved session."
## 3 agent done ctx 7/1000
  text "Saved turn."
## 4 user outcome_unknown
  text "Start uncertain work."
## 5 agent error
  tool bash "**Bash** ```bash printf example ```" → error "Pi process exited (1)"
  tool subagent "**subagent** ```json { \"agent\": \"reviewer\", \"task\": \"Review the sample.\" } ```" → error "Pi process exited (1)"
  card  stopped "Review the sample."
  error "Pi process exited (1)"
## 6 system done
  text "⚠ Delivery outcome unknown for message #4. Verify it before retrying; it will not be resent automatically."
## 7 user done
  text "Continue explicitly."
## 8 agent done ctx 7/1000
  text "Restored turn."
