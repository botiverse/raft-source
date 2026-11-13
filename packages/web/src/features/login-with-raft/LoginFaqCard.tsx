import { Card } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

/** The setup page's side card: what Login with Raft is, registering an App, agents. */
export function LoginFaqCard() {
  const { formatMessage } = useIntl();
  return (
    <Card render={<aside />} className="p-5">
      <h2 className="mb-4 text-headline">{formatMessage({ id: "pages.humanLogin.faqTitle" })}</h2>
      <div className="stack-y-5 text-callout text-foreground-muted">
        <section>
          <h3 className="text-subhead font-bold text-foreground">{formatMessage({ id: "pages.humanLogin.faqWhatTitle" })}</h3>
          <p>
            {formatMessage({ id: "pages.humanLogin.faqWhatBody" })}
          </p>
        </section>
        <section>
          <h3 className="text-subhead font-bold text-foreground">{formatMessage({ id: "pages.humanLogin.faqRegisterTitle" })}</h3>
          <p>
            {formatMessage({ id: "pages.humanLogin.faqRegisterBody" })}
          </p>
        </section>
        <section>
          <h3 className="text-subhead font-bold text-foreground">{formatMessage({ id: "pages.humanLogin.faqAgentTitle" })}</h3>
          <p>
            {formatMessage({ id: "pages.humanLogin.faqAgentBody" })}
          </p>
        </section>
      </div>
    </Card>
  );
}
