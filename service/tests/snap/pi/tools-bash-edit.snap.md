## 1 system done
  text "🤖 **A** joined the team"
## 2 user done
  text "Inspect and update a sample."
## 3 agent done ctx 7/1000
  text "Built-ins complete."
  thinking "Consider the example."
  tool bash "**Bash** timeout 4s ```bash printf example ```" → "Synthetic bash result." 5ms
  tool edit "**Edit** `example.txt` ```diff - old + new - before + after ``` ```json { \"dryRun\": true } ```" → "Synthetic edit result." 5ms
  tool read "**Read** `docs/example.txt`" → "Synthetic read result." 5ms
  tool grep "**Grep** `example` in `example.txt` · ignore case" → "Synthetic grep result." 5ms
