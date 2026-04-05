import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ILogger } from "cyrus-core";
import type { SlackFile } from "cyrus-slack-event-transport";
import { fileTypeFromBuffer } from "file-type";

type DownloadedSlackAttachment = {
	file: SlackFile;
	localPath: string;
	handoffPath?: string;
	isImage: boolean;
};

/**
 * Downloads Slack-uploaded files into chat workspaces so Slack sessions can
 * inspect screenshots and attachments just like Linear-backed sessions do.
 */
export class SlackAttachmentService {
	private readonly logger: ILogger;

	constructor(logger: ILogger) {
		this.logger = logger;
	}

	/**
	 * Download unique Slack files into `<workspace>/attachments` and mirror them
	 * into a stable handoff directory under `~/.cyrus/slack-handoffs/...`.
	 *
	 * We key files by Slack file ID so repeated thread mentions can reuse the
	 * same local copy without re-downloading unchanged uploads.
	 */
	async downloadFiles(
		files: SlackFile[],
		workspacePath: string,
		token: string,
	): Promise<string> {
		const uniqueFiles = this.dedupeFiles(files);
		if (uniqueFiles.length === 0) {
			return "";
		}

		const attachmentsDir = join(workspacePath, "attachments");
		await mkdir(attachmentsDir, { recursive: true });
		const handoffDir = await this.ensureHandoffDirectory(workspacePath);

		const existingFiles: string[] = await readdir(attachmentsDir).catch(
			() => [],
		);
		const existingHandoffFiles: string[] = handoffDir
			? await readdir(handoffDir).catch(() => [])
			: [];
		const downloadedFiles: DownloadedSlackAttachment[] = [];
		let skippedCount = 0;
		let failedCount = 0;

		for (const file of uniqueFiles) {
			const existingPath = this.findExistingPath(file.id, existingFiles);
			if (existingPath) {
				skippedCount++;
				continue;
			}

			const downloadUrl = file.url_private_download || file.url_private;
			if (!downloadUrl) {
				this.logger.warn(
					`Skipping Slack file ${file.id} because it has no private download URL`,
				);
				failedCount++;
				continue;
			}

			const result = await this.downloadFile(
				file,
				downloadUrl,
				attachmentsDir,
				handoffDir,
				token,
				existingHandoffFiles,
			);
			if (!result) {
				failedCount++;
				continue;
			}

			downloadedFiles.push(result);
			existingFiles.push(basename(result.localPath));
		}

		return this.generateManifest({
			attachmentsDir,
			downloadedFiles,
			skippedCount,
			failedCount,
		});
	}

	private dedupeFiles(files: SlackFile[]): SlackFile[] {
		const byId = new Map<string, SlackFile>();
		for (const file of files) {
			if (!file.id) {
				continue;
			}

			// Keep the most complete metadata we see for each Slack file ID.
			const existing = byId.get(file.id);
			byId.set(
				file.id,
				existing
					? {
							...existing,
							...file,
						}
					: file,
			);
		}
		return [...byId.values()];
	}

	private findExistingPath(
		fileId: string,
		existingFiles: string[],
	): string | undefined {
		const match = existingFiles.find(
			(file) =>
				file.startsWith(`image_${fileId}.`) ||
				file.startsWith(`attachment_${fileId}.`),
		);
		return match;
	}

	private async downloadFile(
		file: SlackFile,
		downloadUrl: string,
		attachmentsDir: string,
		handoffDir: string | null,
		token: string,
		existingHandoffFiles: string[],
	): Promise<DownloadedSlackAttachment | null> {
		try {
			const response = await fetch(downloadUrl, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) {
				this.logger.warn(
					`Failed to download Slack file ${file.id}: ${response.status} ${response.statusText}`,
				);
				return null;
			}

			const buffer = Buffer.from(await response.arrayBuffer());
			const detectedFileType = await fileTypeFromBuffer(buffer);
			const isImage =
				(detectedFileType?.mime?.startsWith("image/") ?? false) ||
				(file.mimetype?.startsWith("image/") ?? false);

			const extension =
				(detectedFileType ? `.${detectedFileType.ext}` : undefined) ||
				this.resolveExtension(file);
			const localFilename = `${isImage ? "image" : "attachment"}_${file.id}${extension ?? ""}`;
			const localPath = join(attachmentsDir, localFilename);

			// Persist into the workspace so later follow-ups can reuse the same file.
			await writeFile(localPath, buffer);

			let handoffPath: string | undefined;
			if (handoffDir) {
				const handoffFilename = localFilename;
				handoffPath = join(handoffDir, handoffFilename);
				// Mirror into a stable shared directory so future Linear sessions can
				// inspect the same Slack artifact after work moves out of chat mode.
				if (!existingHandoffFiles.includes(handoffFilename)) {
					await writeFile(handoffPath, buffer);
					existingHandoffFiles.push(handoffFilename);
				}
			}

			return {
				file,
				localPath,
				handoffPath,
				isImage,
			};
		} catch (error) {
			this.logger.warn(
				`Error downloading Slack file ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	private resolveExtension(file: SlackFile): string | undefined {
		const nameExtension = file.name ? extname(file.name) : "";
		if (nameExtension) {
			return nameExtension;
		}

		if (file.filetype) {
			return `.${file.filetype}`;
		}

		return undefined;
	}

	private async ensureHandoffDirectory(
		workspacePath: string,
	): Promise<string | null> {
		const workspacesDir = dirname(workspacePath);
		if (!workspacesDir.endsWith("slack-workspaces")) {
			return null;
		}

		const cyrusHome = dirname(workspacesDir);
		const handoffDir = join(
			cyrusHome,
			"slack-handoffs",
			basename(workspacePath),
		);
		await mkdir(handoffDir, { recursive: true });
		return handoffDir;
	}

	private generateManifest(input: {
		attachmentsDir: string;
		downloadedFiles: DownloadedSlackAttachment[];
		skippedCount: number;
		failedCount: number;
	}): string {
		const { attachmentsDir, downloadedFiles, skippedCount, failedCount } =
			input;
		if (downloadedFiles.length === 0) {
			return "";
		}

		const imageFiles = downloadedFiles.filter((file) => file.isImage);
		const otherFiles = downloadedFiles.filter((file) => !file.isImage);

		let manifest = "## Downloaded Slack Attachments\n\n";
		manifest += `Saved ${downloadedFiles.length} new Slack attachment${downloadedFiles.length === 1 ? "" : "s"} to \`${attachmentsDir}\``;
		if (skippedCount > 0) {
			manifest += `, skipped ${skippedCount} already-downloaded file${skippedCount === 1 ? "" : "s"}`;
		}
		if (failedCount > 0) {
			manifest += `, and failed ${failedCount}`;
		}
		manifest += ".\n\n";

		if (imageFiles.length > 0) {
			manifest += "### Images\n";
			for (const [index, entry] of imageFiles.entries()) {
				manifest += `${index + 1}. ${entry.file.title || entry.file.name || entry.file.id}\n`;
				manifest += `   Local path: ${entry.localPath}\n`;
				if (entry.handoffPath) {
					manifest += `   Linear handoff path: ${entry.handoffPath}\n`;
				}
				manifest += "\n";
			}
			manifest +=
				"Use the Read tool to inspect these images. If you create a tracker issue for implementation, copy the Linear handoff paths into that issue so the background coding session can inspect the same files.\n\n";
		}

		if (otherFiles.length > 0) {
			manifest += "### Files\n";
			for (const [index, entry] of otherFiles.entries()) {
				manifest += `${index + 1}. ${entry.file.title || entry.file.name || entry.file.id}\n`;
				manifest += `   Local path: ${entry.localPath}\n`;
				if (entry.handoffPath) {
					manifest += `   Linear handoff path: ${entry.handoffPath}\n`;
				}
				manifest += "\n";
			}
			manifest +=
				"Use the Read tool to inspect these files. If you create a tracker issue for implementation, copy the Linear handoff paths into that issue so the background coding session can inspect the same files.\n\n";
		}

		return manifest;
	}
}
