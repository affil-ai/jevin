import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackAttachmentService } from "../src/SlackAttachmentService.js";
import { TEST_CYRUS_CHAT } from "./test-dirs.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SlackAttachmentService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("downloads Slack images into the workspace attachments directory", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => Buffer.from("fake image bytes"),
		});

		const service = new SlackAttachmentService(
			createLogger({ component: "SlackAttachmentServiceTest" }),
		);
		const workspacePath = join(
			TEST_CYRUS_CHAT,
			"slack-workspaces",
			"slack-attachment-service",
		);

		const manifest = await service.downloadFiles(
			[
				{
					id: "FIMG1",
					name: "bug.png",
					title: "bug.png",
					mimetype: "image/png",
					url_private_download: "https://files.slack.test/FIMG1",
				},
			],
			workspacePath,
			"xoxb-test",
		);

		const localPath = join(workspacePath, "attachments", "image_FIMG1.png");
		const handoffPath = join(
			TEST_CYRUS_CHAT,
			"slack-handoffs",
			"slack-attachment-service",
			"image_FIMG1.png",
		);
		await expect(access(localPath)).resolves.toBeUndefined();
		await expect(access(handoffPath)).resolves.toBeUndefined();
		await expect(readFile(localPath, "utf8")).resolves.toBe("fake image bytes");
		expect(manifest).toContain("## Downloaded Slack Attachments");
		expect(manifest).toContain(localPath);
		expect(manifest).toContain("Linear handoff path");
		expect(manifest).toContain(handoffPath);
	});

	it("skips files that were already downloaded for the thread workspace", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => Buffer.from("fake pdf bytes"),
		});

		const service = new SlackAttachmentService(
			createLogger({ component: "SlackAttachmentServiceTest" }),
		);
		const workspacePath = join(
			TEST_CYRUS_CHAT,
			"slack-workspaces",
			"slack-attachment-dedupe",
		);
		const file = {
			id: "FPDF1",
			name: "repro.pdf",
			title: "repro.pdf",
			mimetype: "application/pdf",
			url_private_download: "https://files.slack.test/FPDF1",
		};

		await service.downloadFiles([file], workspacePath, "xoxb-test");
		const secondManifest = await service.downloadFiles(
			[file],
			workspacePath,
			"xoxb-test",
		);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(secondManifest).toBe("");
	});
});
