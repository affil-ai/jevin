import type { SlackMessageService } from "cyrus-slack-event-transport";
import { describe, expect, it, vi } from "vitest";
import type { SlackAttachmentService } from "../src/SlackAttachmentService.js";
import { SlackChatAdapter } from "../src/SlackChatAdapter.js";

describe("SlackChatAdapter attachment prompts", () => {
	it("includes thread context, stripped instructions, and downloaded attachment manifest on new sessions", async () => {
		const slackMessageService = {
			fetchThreadMessages: vi.fn().mockResolvedValue([
				{
					user: "U123",
					text: "Markers are gone on mobile",
					ts: "1700000000.000100",
					files: [
						{
							id: "FTHREAD",
							name: "thread-shot.png",
							mimetype: "image/png",
							url_private_download: "https://files.slack.test/FTHREAD",
						},
					],
				},
			]),
			getIdentity: vi
				.fn()
				.mockResolvedValue({ bot_id: "B-CYRUS", user_id: "U-BOT" }),
			postMessage: vi.fn(),
		} as unknown as SlackMessageService;

		const slackAttachmentService = {
			downloadFiles: vi
				.fn()
				.mockResolvedValue("## Downloaded Slack Attachments\n\nsaved image"),
		} as unknown as SlackAttachmentService;

		const adapter = new SlackChatAdapter([], undefined, {
			slackMessageService,
			slackAttachmentService,
		});

		const prompt = await adapter.prepareInitialPrompt(
			{
				eventId: "Ev1",
				teamId: "T1",
				slackBotToken: "xoxb-test",
				payload: {
					type: "app_mention",
					user: "U123",
					channel: "C1",
					text: "<@U0BOT1234> please fix the missing markers",
					ts: "1700000000.000200",
					thread_ts: "1700000000.000100",
					event_ts: "1700000000.000200",
					files: [
						{
							id: "FEVENT",
							name: "current-shot.png",
							mimetype: "image/png",
							url_private_download: "https://files.slack.test/FEVENT",
						},
					],
				},
			},
			"/tmp/slack-workspace",
		);

		expect(prompt).toContain("<slack_thread_context>");
		expect(prompt).toContain("please fix the missing markers");
		expect(prompt).toContain("## Downloaded Slack Attachments");
		expect(
			(slackAttachmentService.downloadFiles as any).mock.calls[0][0],
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "FTHREAD" }),
				expect.objectContaining({ id: "FEVENT" }),
			]),
		);
	});

	it("appends newly downloaded Slack files to follow-up prompts", async () => {
		const slackMessageService = {
			fetchThreadMessages: vi.fn().mockResolvedValue([]),
			getIdentity: vi
				.fn()
				.mockResolvedValue({ bot_id: "B-CYRUS", user_id: "U-BOT" }),
			postMessage: vi.fn(),
		} as unknown as SlackMessageService;

		const slackAttachmentService = {
			downloadFiles: vi
				.fn()
				.mockResolvedValue("## Downloaded Slack Attachments\n\nsaved pdf"),
		} as unknown as SlackAttachmentService;

		const adapter = new SlackChatAdapter([], undefined, {
			slackMessageService,
			slackAttachmentService,
		});

		const prompt = await adapter.prepareFollowUpPrompt(
			{
				eventId: "Ev2",
				teamId: "T1",
				slackBotToken: "xoxb-test",
				payload: {
					type: "app_mention",
					user: "U123",
					channel: "C1",
					text: "<@U0BOT1234> here's the repro pdf",
					ts: "1700000000.000300",
					event_ts: "1700000000.000300",
					files: [
						{
							id: "FPDF",
							name: "repro.pdf",
							mimetype: "application/pdf",
							url_private_download: "https://files.slack.test/FPDF",
						},
					],
				},
			},
			"/tmp/slack-workspace",
		);

		expect(prompt).toContain("here's the repro pdf");
		expect(prompt).toContain("## Downloaded Slack Attachments");
		expect(slackMessageService.fetchThreadMessages).not.toHaveBeenCalled();
	});
});
