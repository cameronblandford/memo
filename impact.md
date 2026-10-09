# Impact and effort

Each memo to the owner has an impact and an effort. The Inbox shows the memo with the highest impact for each unit of effort first. Select the two values with care: a wrong value moves a memo above work that matters more.

## Impact: how much the result matters to the owner

Rate the result for the owner, not the result for your task.

| Impact | Meaning | Examples |
|---|---|---|
| 5 | A hard deadline, or money, health, legal position, or data is at risk. | A bill that is due this week. A defect that loses user data. A form with a legal date. |
| 4 | Work that is complete stops until the owner acts, or the decision sets the direction of a project that the owner works on now. | Approve a deploy that is ready. Select one of two designs for a feature in progress. |
| 3 | The memo moves an active project. No damage occurs if it waits one week. | A question about the behavior of a new command. A review of a draft. |
| 2 | A small improvement or a preference. You have a default and you continue with it. | The name of a setting. The text of a label. |
| 1 | Information that the owner does not need to act on, or a choice that changes almost nothing. | A color name. A note that a low-risk update is complete. |

Rules:

- If you can continue on a default, the impact is 3 or less.
- Do not use 5 because many tasks wait. Use 5 only for the reasons in the table.
- When `memo send` prints corrections from the owner, read them. If the owner decreased your memos, select a lower impact for memos of that type.

## Effort: the time of the owner, not your time

| Size | Time of the owner |
|---|---|
| `micro` | Less than 2 minutes: one tap, one line. |
| `short` | 2 to 15 minutes: read a draft, compare two options. |
| `hour` | 15 to 60 minutes: fill in a form, review a large change. |
| `half-day` | 1 to 4 hours: an appointment, a long session of work. |
| `day` | More than 4 hours. |

Rules:

- Prepare the work so that the size is as small as possible. A question with a recommendation and a default is `micro`.
- Divide a large memo if a part of it can be `micro`.

## Due date

Give `--due` only for a real deadline, or for an event at a fixed time. A memo with a due date in the next 2 days goes to the top of the Inbox, above all memos without one.
