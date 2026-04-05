# Affil Fork Changes

This file tracks changes that exist in the Affil fork but may not exist upstream in `ceedaragents/cyrus`.

## How To Use This File

- Add one dated entry per fork-specific change or behavior change.
- Include the motivation, the files touched, and any operational follow-up needed.
- Remove or mark entries as synced when the same change lands upstream.

## Entries

### 2026-04-04 - Slack attachment ingestion for chat sessions

**Why**

Affil wants Slack to behave more like Devin for bug triage: a teammate should be able to upload a screenshot in Slack, `@Jevin`, and have the agent inspect the image while creating or refining the implementation task.

**What changed**

- Slack chat sessions now preserve Slack file metadata through the webhook/thread message path.
- Slack chat sessions download uploaded Slack files into the thread workspace under `attachments/`.
- Slack chat sessions mirror those files into `~/.cyrus/slack-handoffs/...` so later Linear coding sessions can inspect the same artifacts.
- Initial Slack prompts can include both thread history and a manifest of downloaded Slack attachments, including the stable Linear handoff paths.
- Follow-up Slack prompts can attach newly uploaded files without forcing Linear to be the only image-capable intake path.
- Slack issue-orchestration instructions now tell the chat agent to preserve those handoff paths in the created Linear issue description.
- The Slack setup manifest now requests the `files:read` bot scope so the bot token can download private Slack uploads.

**Files**

- `packages/slack-event-transport/src/types.ts`
- `packages/slack-event-transport/src/SlackMessageService.ts`
- `packages/edge-worker/src/ChatSessionHandler.ts`
- `packages/edge-worker/src/SlackChatAdapter.ts`
- `packages/edge-worker/src/SlackAttachmentService.ts`
- `skills/cyrus-setup-slack/SKILL.md`

**Operational note**

Existing Slack app installations need the updated `files:read` bot scope. Recreate or update the app manifest and reinstall the app to the workspace before expecting Slack image ingestion to work.
