import axios from "axios";

export type BulletinFailureStage = "download" | "parse";

export interface ParseTiming {
    mode: string;
    status: string;
    durationMs: number;
    detail?: string;
}

export interface BulletinAlertDetails {
    file: string;
    link: string;
    stage: BulletinFailureStage;
    error: string;
    firstFailedAt: string;
    elapsedMs: number;
    attempts: number;
    parserVersion: string;
    imageRef: string;
    architecture: string;
    operationDurationMs: number;
    parseTimings: ParseTiming[];
}

export interface BulletinAlertSender {
    sendFailure(details: BulletinAlertDetails): Promise<boolean>;
    sendRecovery(details: BulletinAlertDetails): Promise<boolean>;
}

export class DiscordBulletinAlertService implements BulletinAlertSender {
    constructor(
        private readonly webhookUrl = process.env.ALERT_WEBHOOK_URL ?? "",
        private readonly paulDiscordId = process.env.PAUL_DISCORD_USER_ID ?? ""
    ) {}

    async sendFailure(details: BulletinAlertDetails): Promise<boolean> {
        return this.send(
            "Maybagyoba parser bulletin failure",
            details,
            0xED4245,
            "The bulletin remains quarantined. Other bulletins continue processing; this one will retry hourly."
        );
    }

    async sendRecovery(details: BulletinAlertDetails): Promise<boolean> {
        return this.send(
            "Maybagyoba parser bulletin recovered",
            details,
            0x57F287,
            "The bulletin parsed successfully and has left quarantine."
        );
    }

    private async send(
        title: string,
        details: BulletinAlertDetails,
        color: number,
        outcome: string
    ): Promise<boolean> {
        if (!this.webhookUrl) return false;

        const timings = details.parseTimings.length > 0
            ? details.parseTimings.map(timing =>
                `${timing.mode}:${timing.status}=${timing.durationMs}ms`
            ).join(", ")
            : `operation=${details.operationDurationMs}ms`;
        const elapsedMinutes = Math.floor(details.elapsedMs / 60000);
        const cleanError = details.error.replace(/[`\r\n]+/g, " ").slice(0, 500);
        const description = [
            `**Bulletin:** [${details.file}](${details.link})`,
            `**Stage:** ${details.stage}`,
            `**Error:** \`${cleanError}\``,
            `**First failure:** ${details.firstFailedAt}`,
            `**Elapsed / attempts:** ${elapsedMinutes}m / ${details.attempts}`,
            `**Parser:** ${details.parserVersion}`,
            `**Image / architecture:** ${details.imageRef} / ${details.architecture}`,
            `**Timings:** ${timings}`,
            "",
            outcome
        ].join("\n");

        try {
            await axios.post(this.webhookUrl, {
                content: this.paulDiscordId ? `<@${this.paulDiscordId}>` : "",
                embeds: [{title, description, color}]
            }, {
                headers: {"Content-Type": "application/json"},
                timeout: 10000
            });
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({
                event: "pagasa_parser.alert_failed",
                file: details.file,
                type: color === 0x57F287 ? "recovery" : "failure",
                error: message.replace(/\s+/g, " ").slice(0, 300)
            }));
            return false;
        }
    }
}
