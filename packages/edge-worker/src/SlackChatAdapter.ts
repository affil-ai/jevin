import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	SlackMessageService,
	SlackReactionService,
	type SlackThreadMessage,
	type SlackWebhookEvent,
	stripMention as stripSlackMention,
} from "cyrus-slack-event-transport";
import type { ChatPlatformAdapter } from "./ChatSessionHandler.js";
import { SlackAttachmentService } from "./SlackAttachmentService.js";

/**
 * Slack implementation of ChatPlatformAdapter.
 *
 * Contains all Slack-specific logic extracted from EdgeWorker:
 * text extraction, thread keys, system prompts, thread context,
 * reply posting, and acknowledgement reactions.
 */
export class SlackChatAdapter
	implements ChatPlatformAdapter<SlackWebhookEvent>
{
	readonly platformName = "slack" as const;
	private repositoryPaths: string[];
	private repositoryRoutingContext: string;
	private logger: ILogger;
	private selfBotId: string | undefined;
	private slackMessageService: SlackMessageService;
	private slackAttachmentService: SlackAttachmentService;

	constructor(
		repositoryPaths: string[] = [],
		logger?: ILogger,
		options?: {
			repositoryRoutingContext?: string;
			slackMessageService?: SlackMessageService;
			slackAttachmentService?: SlackAttachmentService;
		},
	) {
		this.repositoryPaths = Array.from(
			new Set(repositoryPaths.filter(Boolean)),
		).sort();
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		this.logger = logger ?? createLogger({ component: "SlackChatAdapter" });
		this.slackMessageService =
			options?.slackMessageService ?? new SlackMessageService();
		this.slackAttachmentService =
			options?.slackAttachmentService ??
			new SlackAttachmentService(this.logger);
	}

	/**
	 * Get the Slack bot token, falling back to process.env if the event doesn't carry one.
	 *
	 * The event's slackBotToken is set at webhook-reception time by SlackEventTransport.
	 * During startup transitions (e.g. switching from cloud to self-host), the token may
	 * not yet be in process.env when the event is created but may arrive shortly after
	 * via an async env update. This fallback ensures the token is picked up even if
	 * it was loaded into process.env after the event was created.
	 */
	private getSlackBotToken(event: SlackWebhookEvent): string | undefined {
		return event.slackBotToken ?? process.env.SLACK_BOT_TOKEN;
	}

	private async getSelfBotId(token: string): Promise<string | undefined> {
		if (this.selfBotId) {
			return this.selfBotId;
		}
		try {
			const identity = await this.slackMessageService.getIdentity(token);
			this.selfBotId = identity.bot_id;
			return this.selfBotId;
		} catch (error) {
			this.logger.warn(
				`Failed to resolve bot identity: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	extractTaskInstructions(event: SlackWebhookEvent): string {
		return (
			stripSlackMention(event.payload.text) || "Ask the user for more context"
		);
	}

	getThreadKey(event: SlackWebhookEvent): string {
		const threadTs = event.payload.thread_ts || event.payload.ts;
		return `${event.payload.channel}:${threadTs}`;
	}

	getEventId(event: SlackWebhookEvent): string {
		return event.eventId;
	}

	async prepareInitialPrompt(
		event: SlackWebhookEvent,
		workspacePath: string,
	): Promise<string> {
		const taskInstructions = this.extractTaskInstructions(event);
		const token = this.getSlackBotToken(event);
		if (!token) {
			const threadContext = await this.fetchThreadContext(event);
			return threadContext
				? `${threadContext}\n\n${taskInstructions}`
				: taskInstructions;
		}

		const threadData = await this.fetchThreadData(event, token);
		const threadContext = threadData
			? this.formatThreadContext(threadData.messages, threadData.selfBotId)
			: "";
		const attachmentManifest = await this.downloadSlackAttachments(
			event,
			workspacePath,
			token,
			threadData?.messages ?? [],
		);

		return [threadContext, taskInstructions, attachmentManifest]
			.filter(Boolean)
			.join("\n\n");
	}

	async prepareFollowUpPrompt(
		event: SlackWebhookEvent,
		workspacePath: string,
	): Promise<string> {
		const taskInstructions = this.extractTaskInstructions(event);
		const token = this.getSlackBotToken(event);
		if (!token) {
			return taskInstructions;
		}

		const threadData = await this.fetchThreadData(event, token);
		const attachmentManifest = await this.downloadSlackAttachments(
			event,
			workspacePath,
			token,
			threadData?.messages ?? [],
		);

		return [taskInstructions, attachmentManifest].filter(Boolean).join("\n\n");
	}

	buildSystemPrompt(event: SlackWebhookEvent): string {
		const repositoryAccessSection =
			this.repositoryPaths.length > 0
				? `
## Repository Access
- You have read-only access to the following configured repositories:
${this.repositoryPaths.map((path) => `- ${path}`).join("\n")}

- If you need to inspect source code in one of these repositories, use:
  - Bash(git -C * pull)

- You are explicitly allowed to run git pull with:
  - Bash(git -C * pull)
			`
				: `
## Repository Access
- No repository paths are configured for this chat session.`;

		return `You are responding to a Slack @mention.

## Context
- **Requested by**: ${event.payload.user}
- **Channel**: ${event.payload.channel}

## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Slack
- If the user's request involves code changes, help them plan the work and suggest creating an issue in their project tracker (Linear, Jira, or GitHub Issues)
- You can answer questions, provide analysis, help with planning, and assist with research
- If files need to be created or examined, they will be in your working directory
${repositoryAccessSection}
${this.repositoryRoutingContext ? `\n\n${this.repositoryRoutingContext}` : ""}

## Self-Knowledge
- If the user asks about your capabilities, features, how you work, what you can do, setup instructions, or anything related to Cyrus documentation, use the \`mcp__cyrus-docs__search_documentation\` tool to look up the answer from the official Cyrus docs.
- Always prefer searching the docs over guessing or relying on your training data for Cyrus-specific questions.

## Orchestration Notes
- If the user asks you to make repo code changes immediately, use these steps:
  - First run \`mcp__linear__get_user\` with \`query: "me"\` to get your Linear identity.
  - Create an Issue in the user's tracker for the requested work (for example using \`mcp__linear__save_issue\`), including enough context and acceptance criteria to execute it. Default the issue status/state to "Backlog". **IMPORTANT: Never set the status to "Triage".**
  - If the prompt includes a "Downloaded Slack Attachments" section, copy the listed Linear handoff paths into the created issue description so the future background coding session can inspect the same files.
  - To route the issue to a specific repository, add \`[repo=repo-name]\` to the issue description. To target a specific branch, use \`[repo=repo-name#branch-name]\`. For multiple repos: \`repos=repo1,repo2\`.
  - Assign that Issue to that same user (your own Linear user).
  - That assignment is what immediately kicks off work in your own agent session.
  - Track execution progress by searching \`mcp__cyrus-tools__linear_get_agent_sessions\` for the active session, then opening it with \`mcp__cyrus-tools__linear_get_agent_session\`.

## Slack Message Formatting (CRITICAL)
Your response will be posted as a Slack message. Slack uses its own "mrkdwn" format, which is NOT standard Markdown. You MUST follow these rules exactly.

NEVER use any of the following — they do not render in Slack and will appear as broken plain text:
- NO tables (no | --- | syntax — use numbered lists or plain text instead)
- NO headers (no # syntax — use *bold text* on its own line instead)
- NO [text](url) links — use <url|text> instead
- NO **double asterisk** bold — use *single asterisk* instead
- NO image embeds

Supported mrkdwn syntax:
- Bold: *bold text* (single asterisks only)
- Italic: _italic text_
- Strikethrough: ~struck text~
- Inline code: \`code\`
- Code blocks: \`\`\`code block\`\`\`
- Blockquote: > quoted text (at start of line)
- Links: <https://example.com|display text>
- Lists: use plain numbered lines (1. item) or dashes (- item) with newlines`;
	}

	async fetchThreadContext(event: SlackWebhookEvent): Promise<string> {
		// Only fetch context for threaded messages
		if (!event.payload.thread_ts) {
			return "";
		}

		const token = this.getSlackBotToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot fetch Slack thread context: no slackBotToken available",
			);
			return "";
		}

		try {
			const threadData = await this.fetchThreadData(event, token);
			if (!threadData || threadData.messages.length === 0) {
				return "";
			}

			// Include all messages (user and bot) so follow-up sessions retain
			// full conversation history, especially when the runner type changes.
			return this.formatThreadContext(
				threadData.messages,
				threadData.selfBotId,
			);
		} catch (error) {
			this.logger.warn(
				`Failed to fetch Slack thread context: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "";
		}
	}

	async postReply(
		event: SlackWebhookEvent,
		runner: IAgentRunner,
	): Promise<void> {
		try {
			const messages = runner.getMessages();
			let summary =
				this.extractLastAssistantText(messages) ?? "Task completed.";
			const createdIssue = this.findCreatedLinearIssue(messages);

			// Post the raw Linear URL so Slack can generate the native unfurl card
			// shown in the thread, instead of just rendering a plain mrkdwn link.
			if (createdIssue && !summary.includes(createdIssue.url)) {
				summary = `${summary}\n\nLinear issue: ${createdIssue.identifier}\n${createdIssue.url}`;
			}

			const token = this.getSlackBotToken(event);
			if (!token) {
				this.logger.warn("Cannot post Slack reply: no slackBotToken available");
				return;
			}

			// Thread the reply under the original message
			const threadTs = event.payload.thread_ts || event.payload.ts;

			await this.slackMessageService.postMessage({
				token,
				channel: event.payload.channel,
				text: summary,
				thread_ts: threadTs,
			});

			this.logger.info(
				`Posted Slack reply to channel ${event.payload.channel} (thread ${threadTs})`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post Slack reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	async acknowledgeReceipt(event: SlackWebhookEvent): Promise<void> {
		const token = this.getSlackBotToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot add Slack reaction: no slackBotToken available (SLACK_BOT_TOKEN env var not set)",
			);
			return;
		}

		await new SlackReactionService().addReaction({
			token,
			channel: event.payload.channel,
			timestamp: event.payload.ts,
			name: "eyes",
		});
	}

	async notifyBusy(event: SlackWebhookEvent): Promise<void> {
		const token = this.getSlackBotToken(event);
		if (!token) {
			return;
		}

		const threadTs = event.payload.thread_ts || event.payload.ts;

		await this.slackMessageService.postMessage({
			token,
			channel: event.payload.channel,
			text: "I'm still working on the previous request in this thread. I'll pick up your new message once I'm done.",
			thread_ts: threadTs,
		});
	}

	private async fetchThreadData(
		event: SlackWebhookEvent,
		token: string,
	): Promise<{ messages: SlackThreadMessage[]; selfBotId?: string } | null> {
		if (!event.payload.thread_ts) {
			return null;
		}

		const [messages, selfBotId] = await Promise.all([
			this.slackMessageService.fetchThreadMessages({
				token,
				channel: event.payload.channel,
				thread_ts: event.payload.thread_ts,
				limit: 50,
			}),
			this.getSelfBotId(token),
		]);

		return { messages, selfBotId };
	}

	private async downloadSlackAttachments(
		event: SlackWebhookEvent,
		workspacePath: string,
		token: string,
		threadMessages: SlackThreadMessage[],
	): Promise<string> {
		const files = [
			...threadMessages.flatMap((message) => message.files ?? []),
			...(event.payload.files ?? []),
		];
		if (files.length === 0) {
			return "";
		}

		try {
			// Download into the chat workspace so the next runner turn can inspect
			// screenshots even when the source message came from Slack, not Linear.
			return await this.slackAttachmentService.downloadFiles(
				files,
				workspacePath,
				token,
			);
		} catch (error) {
			this.logger.warn(
				`Failed to download Slack attachments: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "";
		}
	}

	private formatThreadContext(
		messages: SlackThreadMessage[],
		selfBotId?: string,
	): string {
		const formattedMessages = messages
			.map((msg) => {
				const isSelf = selfBotId && msg.bot_id === selfBotId;
				const author = isSelf ? "assistant (you)" : (msg.user ?? "unknown");
				return `  <message>
    <author>${author}</author>
    <timestamp>${msg.ts}</timestamp>
    <content>
${msg.text}
    </content>
  </message>`;
			})
			.join("\n");

		return `<slack_thread_context>\n${formattedMessages}\n</slack_thread_context>`;
	}

	private extractLastAssistantText(
		messages: ReturnType<IAgentRunner["getMessages"]>,
	): string | undefined {
		const lastAssistantMessage = [...messages]
			.reverse()
			.find((message) => message.type === "assistant");

		const content = (lastAssistantMessage as any)?.message?.content;
		if (!Array.isArray(content)) {
			return undefined;
		}

		const textBlock = content.find(
			(block: any) => block?.type === "text" && typeof block.text === "string",
		);
		return textBlock?.text;
	}

	private findCreatedLinearIssue(
		messages: ReturnType<IAgentRunner["getMessages"]>,
	): { url: string; identifier: string } | null {
		const toolNamesById = new Map<string, string>();

		// First map tool-use IDs so we can recognize the matching tool_result.
		for (const message of messages) {
			const content = (message as any)?.message?.content;
			if (!Array.isArray(content)) {
				continue;
			}

			for (const block of content) {
				if (block?.type !== "tool_use" || typeof block.id !== "string") {
					continue;
				}
				if (typeof block.name === "string") {
					toolNamesById.set(block.id, block.name);
				}
			}
		}

		// Walk backwards so we pick the most recent created issue in the session.
		for (const message of [...messages].reverse()) {
			const content = (message as any)?.message?.content;
			if (!Array.isArray(content)) {
				continue;
			}

			for (const block of content) {
				if (
					block?.type !== "tool_result" ||
					typeof block.tool_use_id !== "string" ||
					block.is_error
				) {
					continue;
				}

				const toolName = toolNamesById.get(block.tool_use_id);
				if (!toolName?.includes("save_issue")) {
					continue;
				}

				const issue = this.extractLinearIssueFromToolResult(block.content);
				if (issue) {
					return issue;
				}
			}
		}

		return null;
	}

	private extractLinearIssueFromToolResult(
		content: unknown,
	): { url: string; identifier: string } | null {
		const flattenedContent = this.flattenToolResultContent(content);
		if (flattenedContent.length === 0) {
			return null;
		}

		for (const entry of flattenedContent) {
			const issue = this.findLinearIssueInValue(entry);
			if (issue) {
				return issue;
			}
		}

		return null;
	}

	private flattenToolResultContent(content: unknown): unknown[] {
		if (Array.isArray(content)) {
			return content.flatMap((entry) => this.flattenToolResultContent(entry));
		}

		if (typeof content === "string") {
			const trimmed = content.trim();
			if (trimmed.length === 0) {
				return [];
			}

			try {
				return [JSON.parse(trimmed)];
			} catch {
				return [trimmed];
			}
		}

		if (
			content &&
			typeof content === "object" &&
			"text" in content &&
			typeof (content as { text?: unknown }).text === "string"
		) {
			return this.flattenToolResultContent((content as { text: string }).text);
		}

		if (content == null) {
			return [];
		}

		return [content];
	}

	private findLinearIssueInValue(
		value: unknown,
	): { url: string; identifier: string } | null {
		if (typeof value === "string") {
			const urlMatch = value.match(/https:\/\/linear\.app\/\S+/);
			if (!urlMatch) {
				return null;
			}

			const identifierMatch = value.match(/\b[A-Z][A-Z0-9]+-\d+\b/);
			return {
				url: urlMatch[0],
				identifier: identifierMatch?.[0] ?? "Linear issue",
			};
		}

		if (Array.isArray(value)) {
			for (const entry of value) {
				const nestedIssue = this.findLinearIssueInValue(entry);
				if (nestedIssue) {
					return nestedIssue;
				}
			}
			return null;
		}

		if (!value || typeof value !== "object") {
			return null;
		}

		const candidate = value as {
			url?: unknown;
			identifier?: unknown;
			issue?: unknown;
		};
		if (
			typeof candidate.url === "string" &&
			candidate.url.includes("linear.app")
		) {
			return {
				url: candidate.url,
				identifier:
					typeof candidate.identifier === "string"
						? candidate.identifier
						: "Linear issue",
			};
		}

		for (const nestedValue of Object.values(candidate)) {
			const nestedIssue = this.findLinearIssueInValue(nestedValue);
			if (nestedIssue) {
				return nestedIssue;
			}
		}

		return null;
	}
}
