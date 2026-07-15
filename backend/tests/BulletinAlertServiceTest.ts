const mockPost = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: {post: mockPost}
}));

import {
    BulletinAlertDetails,
    DiscordBulletinAlertService
} from "../src/alerts/BulletinAlertService";

const details: BulletinAlertDetails = {
    file: "TCB#3_josie.pdf",
    link: "https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin/TCB%233_josie.pdf",
    stage: "parse",
    error: "Unable to extract coordinates",
    firstFailedAt: "2026-07-15T00:00:00.000Z",
    elapsedMs: 60 * 60 * 1000,
    attempts: 5,
    parserVersion: "pagasa-parser-web/1.3.0 source-pdf/test-sha",
    imageRef: "ghcr.io/jjompong/pagasa-parser-web:test",
    architecture: "arm64",
    operationDurationMs: 1820,
    parseTimings: [
        {mode: "stream", status: "succeeded", durationMs: 820},
        {mode: "lattice", status: "succeeded", durationMs: 910}
    ]
};

describe("DiscordBulletinAlertService", () => {
    beforeEach(() => {
        mockPost.mockReset().mockResolvedValue({status: 204});
    });

    test("sends the operational fields through the configured Dawn-style webhook", async () => {
        const alerts = new DiscordBulletinAlertService(
            "https://discord.example.invalid/webhook",
            "123456"
        );

        await expect(alerts.sendFailure(details)).resolves.toBe(true);
        expect(mockPost).toHaveBeenCalledTimes(1);
        const [url, payload, config] = mockPost.mock.calls[0];
        expect(url).toBe("https://discord.example.invalid/webhook");
        expect(payload.content).toBe("<@123456>");
        expect(payload.embeds[0].title).toContain("bulletin failure");
        expect(payload.embeds[0].description).toContain(details.file);
        expect(payload.embeds[0].description).toContain(details.link);
        expect(payload.embeds[0].description).toContain("**Stage:** parse");
        expect(payload.embeds[0].description).toContain(details.firstFailedAt);
        expect(payload.embeds[0].description).toContain("60m / 5");
        expect(payload.embeds[0].description).toContain(details.parserVersion);
        expect(payload.embeds[0].description).toContain(`${details.imageRef} / arm64`);
        expect(payload.embeds[0].description).toContain("stream:succeeded=820ms");
        expect(payload.embeds[0].description).toContain("lattice:succeeded=910ms");
        expect(config.timeout).toBe(10000);
    });

    test("sends a distinct recovery notification", async () => {
        const alerts = new DiscordBulletinAlertService(
            "https://discord.example.invalid/webhook",
            "123456"
        );

        await expect(alerts.sendRecovery(details)).resolves.toBe(true);
        expect(mockPost.mock.calls[0][1].embeds[0].title).toContain("recovered");
        expect(mockPost.mock.calls[0][1].embeds[0].description).toContain(
            "left quarantine"
        );
    });

    test("is a no-op when no webhook is configured", async () => {
        const alerts = new DiscordBulletinAlertService("", "123456");

        await expect(alerts.sendFailure(details)).resolves.toBe(false);
        expect(mockPost).not.toHaveBeenCalled();
    });
});
