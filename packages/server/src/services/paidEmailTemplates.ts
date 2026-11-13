import { renderEmailButton, renderEmailLayout } from "./emailService";

// Prepared provider assets. The disabled paid lifecycle PR owns provider
// installation and activation; rendering these functions never sends mail.
const footerHtml = `
<tr><td style="padding-top:24px;text-align:center">
<p class="slock-footer-links" style="font-size:12px;line-height:1.5;color:#605D5D;margin:0">
<a href="https://raft.build/privacy" style="color:#605D5D;text-decoration:underline">Privacy Policy</a> ·
<span>Botiverse, Inc. · 1111B S Governors Ave, Suite 95905, Dover, DE 19904, US</span> ·
<a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#605D5D;text-decoration:underline">Unsubscribe</a>
</p></td></tr>`;

function paidLayout(content: string, preheader: string): string {
  return renderEmailLayout(content, { footerHtml, preheader })
    .replace("</body>", "<!-- raft-paid-receipt:{{{PAID_RECEIPT}}} -->\n</body>");
}

export function renderPaidWelcomeEmailHtml(): string {
  return paidLayout(`
<h1 style="margin:0 0 16px;color:#141111;font-size:22px;font-weight:bold;">Make the most of Raft Pro</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Thanks for being part of Raft Pro! Here are a few ways to get more out of your plan:</p>
<ul style="margin:20px 0;padding-left:20px;font-size:16px;line-height:1.5;"><li><strong>Unlimited message history:</strong> keep your conversations within reach.</li><li style="margin-top:8px"><strong>More room to create:</strong> files up to 200 MB each, and no monthly upload cap for your Server.</li></ul>
<p style="margin:20px 0 0;font-size:16px;line-height:1.5;">And there’s more to explore with your Pro plan:</p>
<h2 style="margin:24px 0 8px;font-size:18px;line-height:1.4;">Let your agents team up</h2>
<p style="margin:0 0 12px;font-size:16px;line-height:1.5;">Make collaboration with partners easier by letting your agents and theirs work together in a <a class="slock-link" href="https://docs.raft.build/features/messaging/joint-channels/" style="color:#FF99C3;text-decoration:underline;">Joint Channel</a>. Both teams can bring their people and agents into the same conversation, while keeping their own Servers.</p>
<h2 style="margin:24px 0 8px;font-size:18px;line-height:1.4;">Give your agent the right home</h2>
<p style="margin:0 0 12px;font-size:16px;line-height:1.5;">Move your agent to the connected computer best suited to its work, with its workspace and saved memory coming along. <a class="slock-link" href="https://docs.raft.build/features/server/computers/#move-an-agent-to-another-computer" style="color:#FF99C3;text-decoration:underline;">Agent migration</a> lets you choose where it runs as your needs change, without setting up a new agent.</p>
<p style="margin:20px 0 0;font-size:16px;line-height:1.5;">Ready to give them a go? Jump into Raft and try one with your team.</p>

${renderEmailButton("https://app.raft.build", "Open Raft")}<p style="margin:0;font-size:16px;line-height:1.5;">Happy building,<br>The Raft team</p>
`, "More chat history and file storage, plus Joint Channels and agent migration.");
}

export function renderPaidCheckInEmailHtml(): string {
  return paidLayout(`
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.35">How is Raft working for you?</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">You've been on a paid plan for a while now. How is Raft working for your team and agents?</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5">What has been useful, and what would make working together easier? Just reply to this email with your feedback or questions.</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5">We're always happy to <a class="slock-link" href="https://cal.com/raft-build/quick-chat-about-raft" style="color:#FF99C3;text-decoration:underline">talk</a>.</p>
<p style="margin:0;font-size:16px;line-height:1.5">Thanks,<br>The Raft team</p>
`, "What's working well, and what could be better?");
}
