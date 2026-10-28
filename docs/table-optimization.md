# Table optimization

Open the table manager and choose **Table optimization** (`表格优化`). The default
**One-click optimize** action uses the current Chat Completion connection and a
strategy recommended from the current tables. Use **Preview first** to inspect
the result before applying it.

## Built-in strategies

| Strategy | Recent history kept per table | Summary focus |
| --- | ---: | --- |
| Detail | 30 rows | Event chains, necessary details, and unresolved clues |
| Balanced | 20 rows | Scenes, causes, consequences, and persistent changes |
| Deep | 8 rows | Phase milestones, essential facts, and open commitments |

Automatic recommendations use history size and its share of the table content.
Large archives can also trigger a recommendation to compact existing summaries.
The recommendation makes no model request. It cannot judge narrative importance
from row counts alone; choose Detail when fine-grained clues matter.

Each strategy has an editable prompt. Custom prompts are remembered separately,
and the reset action restores only the selected strategy. The recent-history
window can be overridden independently. Character budgets and suggested summary
counts are instructions for the model, not guaranteed compression ratios.

## Connections and models

The connection selector offers the current Chat Completion connection and saved
Chat Completion profiles. Selecting a profile does not switch the main chat
connection. Requests use the selected connection's credentials through the
SillyTavern backend; the optimizer does not ask for or store another API key.

Leave the model and output budget blank to follow the selected connection.
Models can be typed directly or loaded from the selected endpoint when its
provider supports a model-list request. Some providers do not expose that
request; manual model entry remains available.

## What changes

Old history rows are grouped into summaries using the actual destination columns.
Existing summary/archive tables receive the new summaries. If no archive exists,
the history table receives them before the protected recent rows.

Other selected tables only lose exactly identical rows. The model does not
rewrite current character states, quantities, item ownership, or schedules.
Existing summaries are preserved unless archive compaction is selected.

The preview shows overall character counts, each changed table, and the exact
source rows associated with each summary. Source coverage validation detects
omitted, duplicated, and reordered row IDs, but does not prove semantic accuracy.
Check commitments, quantities, relationship direction, and unresolved clues.

## Saving and undo

All batches must finish and pass structural validation before any table changes.
One-click optimization applies results when they reduce the character count;
larger results remain a preview. Closing or cancelling generation does not apply
partial results.

Applying a preview rejects changes to the conversation, active reply, table
content, or table configuration since it was opened. Saving uses the host's
coordinated save path, then reads the saved chat back to verify the affected
tables and backup. Confirmed save failures roll back when the optimizer still
owns the current state. If verification itself is unavailable, the UI reports
uncertainty and preserves the in-memory recovery state.

One persistent undo backup is kept per chat. Undo checks both the table state
and a conversation fingerprint, and refuses to overwrite subsequent dialogue
or edits. Original cell history is retained. Context compression therefore does
not imply an equal reduction in the chat file's disk size.

## Local checks

Run the domain and persistence tests from the extension directory:

```powershell
node --test tests/tableOptimization.test.mjs tests/tableOptimizationPersistence.test.mjs
```

The browser API adapter tests use Node's VM module loader to supply isolated host
modules without rewriting the extension source:

```powershell
node --experimental-vm-modules --test tests/optimizationApi.test.mjs
```

Browser verification should use synthetic chats and intercepted save/generation
requests. Do not apply a test result to a user's live conversation.
