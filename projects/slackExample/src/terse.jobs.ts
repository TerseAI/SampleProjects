import { type GithubPROpenedTrigger, type SlackAppMentionTrigger, type SlackMessageTrigger, TerseAgent, createJob } from "terse-sdk"
import { z } from "zod"

import { Repos, Skills, SlackChannel, Triggers, toolbox } from "./terse.generated"

// Channel everything flows through for the demo.
const DEMO_CHANNEL = SlackChannel.OlivierTerseNotifications

// Repo we listen on for PRs. Swap for whichever repo you want to demo against.
const DEMO_REPO = Repos.TerseAI.Terse

// ─── Job 1: PR opened → Block Kit summary card in #ci-cd ──────────────────
//
// Agent reads the PR diff and produces a structured summary (Zod-typed). We
// post the actual Block Kit card deterministically so the LLM never has to
// emit valid Slack JSON.
createJob({
    name: "PR summary card in #ci-cd",
    triggers: [Triggers.github.onPROpened({ repo: DEMO_REPO })],
    filter: async (event: GithubPROpenedTrigger) => {
        return !event.sender.login.includes("[bot]")
    },
    onTrigger: async (event: GithubPROpenedTrigger) => {
        const agent = TerseAgent.create({
            prompt: "You review pull requests and surface what matters. Be concise; reviewers will read the diff for details.",
            skills: [Skills.github({ repos: [DEMO_REPO] })]
        })

        const review = await agent.runAndWait(
            `Summarise this pull request for the #ci-cd Slack channel.\n\n` +
                `Produce:\n` +
                `- summary: 1–2 sentences on what changed and why.\n` +
                `- risk: low | medium | high.\n` +
                `- riskReason: one line on what to look for (DB migrations, auth/security, breaking API, infra) — or "no obvious risks".\n` +
                `- keyFiles: up to 5 paths reviewers should open first.\n\n` +
                `Context: ${event.formatForAgentRunner()}`,
            z.object({
                summary: z.string(),
                risk: z.enum(["low", "medium", "high"]),
                riskReason: z.string(),
                keyFiles: z.array(z.string())
            })
        )

        const filesChanged = event.commits.flatMap(c => c.fileDiffs.map(f => f.filename))
        const uniqueFiles = Array.from(new Set(filesChanged))

        const blocks = buildPrSummaryBlocks({
            title: event.pullRequest.title,
            url: event.pullRequest.url ?? "",
            author: event.sender.login,
            filesChanged: uniqueFiles.length,
            summary: review.summary,
            risk: review.risk,
            riskReason: review.riskReason,
            keyFiles: review.keyFiles.slice(0, 5)
        })

        await toolbox.slack.sendMessage({
            channelId: DEMO_CHANNEL.channelId,
            message: `New PR by ${event.sender.login}: ${event.pullRequest.title}`,
            blocks: JSON.stringify(blocks),
            thread_ts: ""
        })
    }
})

// ─── Job 2: Thread replies on a PR summary card → in-thread answer ────────
//
// Filter:
//   - must be a thread reply (threadTs set)
//   - skip messages whose username looks like our bot, so we don't loop
//
// We can't cheaply confirm the thread parent is a Terse PR summary from here
// (slack_read_conversation reads channels, not thread parents). For the demo
// the username filter is enough — the bot only replies inside threads in
// #ci-cd, and those threads come from our own PR summary cards.
createJob({
    name: "Answer PR follow-ups in thread",
    triggers: [Triggers.slack.onMessage({ channel: DEMO_CHANNEL })],
    filter: async (event: SlackMessageTrigger) => {
        const threadTs = event.threadTs ?? event.threadTimestamp
        if (!threadTs) return false

        const name = event.userName?.toLowerCase() ?? ""
        if (name.includes("terse") || name.includes("bot")) return false

        return true
    },
    onTrigger: async (event: SlackMessageTrigger) => {
        const threadTs = event.threadTs ?? event.threadTimestamp
        if (!threadTs) return

        const agent = TerseAgent.create({
            prompt:
                "You answer follow-up questions about a pull request in a Slack thread. " +
                "Reply once, in plain Slack mrkdwn, max ~6 lines. Reference exact file paths when possible. " +
                "If the answer isn't in the PR, say so plainly rather than guessing.",
            skills: [Skills.github({ repos: [DEMO_REPO] }), Skills.slack({ channel: DEMO_CHANNEL })]
        })

        await agent.runAndWait(
            `A user asked a follow-up about a PR summary posted to #ci-cd.\n\n` +
                `User's question: ${event.text}\n\n` +
                `Post a single reply in the same thread.\n` +
                `Use slack_send_message with channelId=${event.channelId} and thread_ts=${threadTs}.\n\n` +
                `Context: ${event.formatForAgentRunner()}`
        )
    }
})

// ─── Job 3: @TerseBot investigate … → repo investigation reply ─────────────
//
// User @-mentions the bot with a repo question or bug report, e.g.
// "@TerseBot why does local auth fail after prisma generate?"
// The agent investigates the Terse repo with GitHub code tools and replies in
// the same Slack thread with findings, likely files, and a next step.
createJob({
    name: "Investigate repo app mentions",
    triggers: [Triggers.slack.onAppMention({ channel: DEMO_CHANNEL })],
    filter: async (event: SlackAppMentionTrigger) => {
        return event.text.replace(/<@[^>]+>/g, "").trim().length > 0
    },
    onTrigger: async (event: SlackAppMentionTrigger) => {
        const threadTs = event.threadTs ?? event.threadTimestamp ?? event.timestamp
        const request = event.text.replace(/<@[^>]+>/g, "").trim()

        await toolbox.slack.sendMessage({
            channelId: event.channelId,
            message: `:mag: Looking into this in \`${DEMO_REPO.fullName}\`: ${request}`,
            thread_ts: threadTs,
            blocks: ""
        })

        const agent = TerseAgent.create({
            prompt:
                "You investigate codebase questions and bug reports for the Terse repository. " +
                "Use GitHub code search, grep, directory listing, and file reads to ground your answer in the repo. " +
                "Reply once in plain Slack mrkdwn, max ~10 lines. Include exact file paths when relevant. " +
                "If the request is too vague to investigate, ask one focused clarifying question instead of guessing.",
            skills: [Skills.github({ repos: [DEMO_REPO] }), Skills.slack({ channel: DEMO_CHANNEL })]
        })

        await agent.runAndWait(
            `A user mentioned the app in #ci-cd and asked for a repo investigation.\n\n` +
                `Request: ${request}\n` +
                `Repository: ${DEMO_REPO.fullName}\n\n` +
                `Investigate before answering. You can answer questions about how code works, identify likely bug causes, ` +
                `or point to the most relevant files and next debugging step.\n\n` +
                `Post a single reply in the same Slack thread:\n` +
                `- channelId: ${event.channelId}\n` +
                `- thread_ts: ${threadTs}\n` +
                `- format: concise Slack mrkdwn with file paths in backticks\n\n` +
                `Context: ${event.formatForAgentRunner()}`
        )
    }
})

// ─── Block Kit builder ────────────────────────────────────────────────────

type RiskLevel = "low" | "medium" | "high"

const RISK_EMOJI: Record<RiskLevel, string> = {
    low: ":large_green_circle:",
    medium: ":large_yellow_circle:",
    high: ":red_circle:"
}

function buildPrSummaryBlocks(input: { title: string; url: string; author: string; filesChanged: number; summary: string; risk: RiskLevel; riskReason: string; keyFiles: string[] }) {
    const blocks: Array<Record<string, unknown>> = [
        {
            type: "header",
            text: { type: "plain_text", text: `New PR: ${truncate(input.title, 140)}`, emoji: true }
        },
        {
            type: "context",
            elements: [{ type: "mrkdwn", text: `by *${input.author}* · ${input.filesChanged} file${input.filesChanged === 1 ? "" : "s"} changed` }]
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: input.summary }
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: `${RISK_EMOJI[input.risk]} *Risk: ${input.risk}* — ${input.riskReason}` }
        }
    ]

    if (input.keyFiles.length > 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*Key files*\n${input.keyFiles.map(f => `• \`${f}\``).join("\n")}` }
        })
    }

    if (input.url) {
        blocks.push({
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: "View PR", emoji: true },
                    url: input.url,
                    action_id: "view_pr"
                }
            ]
        })
    }

    return blocks
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
