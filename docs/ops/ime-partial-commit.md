# IME partial-commit replay

## Scope

This report covers a narrowly scoped browser-event replay and review of the keyboard input assist guard. It does not capture Doubao, Windows IME, or a user's live Edge session. The production change was made separately in the parent task; this subtask only changed the replay and report.

## Reproduction sequence

The replay models the suspected split-commit order:

1. `compositionstart`
2. An `insertCompositionText` input with `isComposing: true` updates preedit.
3. Before `compositionend`, an `insertText` or `insertFromComposition` input with `isComposing: false` confirms the prefix `你`.
4. `compositionend.data` contains only the remainder `好，今天的会议改到下午三点。`.
5. A trailing `insertFromComposition` input acknowledges that remainder.

Expected output is exactly one `co,end,你好，今天的会议改到下午三点。` commit. The prefix is already confirmed by the non-composing input; the trailing event must not send the remainder a second time.

## Pre-fix baseline

Before the production change, the 11-case replay recorded 3 failures and 8 passes:

- Both pre-end confirmation variants (`insertText` and `insertFromComposition`) sent only `好，今天的会议改到下午三点。`; the prefix `你` was lost.
- A confirmed prefix followed by an empty `compositionend.data` sent nothing, even when the DOM still equaled the confirmed prefix.
- The other eight cases passed, including no duplication when end data already included the prefix, cancellation of unconfirmed preedit, mismatched-DOM handling, independent same-text input, and intentional repeated commits.

The failures matched the guard gap: the active-composition branch returned for every input on the current composition target, even when `isComposing` was false and `inputType` reported inserted committed text. `compositionend` then queued only its own `data`.

An earlier draft also required an `insertText` event with the same text after the cleanup timer to be treated as an acknowledgement. That case had no preceding `beforeinput` or other new-action signal, so it was indistinguishable from a deliberate second same-text input. It is not counted as a bug. The revised control sends a `beforeinput` first and expects the second input to be delivered.

## Post-fix review and focused replay

The narrow repair follows the intended boundaries:

- It records candidate text only from non-empty `data` on an input with `isComposing === false` and `inputType` `insertText` or `insertFromComposition` during the active composition.
- It joins that confirmed prefix to non-empty `compositionend.data` only when the target DOM value exactly equals `confirmed + event.data`. Otherwise end data remains authoritative, which prevents stale preedit from being inferred and avoids doubling a prefix already present in end data.
- For empty end data, the explicit confirmed prefix is accepted only if the DOM value still supports it; otherwise it is discarded. Unconfirmed preedit is never queued.
- It resets the candidate at composition start/end, blur, a replacement assist input, and explicit IME repair.

Command: `node tests/test_ime_partial_commit.js`

**Post-fix: all 14 focused checks passed.** The three new boundary cases cover multiple confirmed fragments with repeated characters and emoji, a delayed backpressure retry followed by a new composition, and cancellation/remounted-assist isolation. The suite also retains the independent same-text `beforeinput` control, so string-only deduplication would fail.

The remount control observes reset when the first input arrives on the replacement target. It does not model a detached old target dispatching `compositionend` before any event reaches the replacement target. The parent task separately reports that `tests/test_ime_delivery.js` and the 43-case extreme suite pass; those were not rerun in this subtask. No post-fix native Edge + Doubao event capture was performed here.

This replay establishes that the previous guard dropped a confirmed prefix if this sequence occurred, and that the patch preserves it. It does not establish that all browsers use this event order.

## Runtime evidence boundary

Separate runs reported for this task found complete text in native headless Edge/CDP with the bundled input path for ordinary Space/Digit confirmation, and in four real X11 cases covering fresh focus, existing text, held Space, and a held digit. Those checks do not show that this particular split event order occurs in the user's Edge + Doubao session. Confirming whether it occurs requires capturing the live composition/input event sequence while reproducing the symptom.
