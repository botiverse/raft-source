import { useCallback, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { Check } from "lucide-react";
import {
  Banner,
  BannerDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  TextLink,
  ScrollArea,
} from "@botiverse/raft-ui";
import PanelHeader from "../components/ui/PanelHeader";
import { useAppNavigate, useMobileBack } from "../hooks/useAppNavigate";
import { useServerStore } from "../store/serverStore";
import { PRO_SEAT_ADD_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../store/serverFeatureFlags";
import { useServerPermissions } from "../hooks/useServerPermissions";
import type { AddSeatsNeed } from "../components/billing/AddSeatsDialog";
import { PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths } from "@botiverse/raft-shared";
import type { CapacityLimitDetail } from "@botiverse/raft-shared";
import { AssistantCapacityError, createAssistant } from "./assistantClient";
import { deferredDialog } from "../boot/deferredUi";

const AddSeatsDialog = deferredDialog(() => import("../components/billing/AddSeatsDialog"));

const MOBILE_BACK_PROPS = { "data-testid": "assistant-mobile-back" } as const;

/** Why the last create failed: the seat limit carries the server's message, as in Create Agent. */
type CreateFailure = { kind: "generic" } | { kind: "capacity"; message: string };

/**
 * No assistant yet in this server: create it. Every assistant is Ottie (the
 * server sets its name and avatar; the owner does not pick them). The list says what
 * it does from the start (RFC 077: it reads the owner's DMs and can send
 * messages as them, both on by default), each changeable later in Assistant
 * Permissions.
 */
export default function CreateAssistantView() {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | null>(null);
  const nav = useAppNavigate();
  const handleViewPlans = useCallback(() => nav.toSettings("billing"), [nav]);

  // Pro seats ran out (task #10, behind pro_seat_add): an owner adds them here,
  // a member asks an owner, with the refusal's numbers (members can't read billing).
  const seatAddEnabled = useServerFeatureFlag(PRO_SEAT_ADD_FEATURE_FLAG_KEY).enabled;
  const { capabilities } = useServerPermissions();
  const serverName = useServerStore((s) => s.current?.name ?? "");
  const [seatRefusal, setSeatRefusal] = useState<CapacityLimitDetail | null>(null);

  const submit = useCallback(() => {
    setFailure(null);
    setSubmitting(true);
    // On success (or a 409 adopting the existing one) the page re-renders into
    // the assistant's DM, unmounting this view.
    createAssistant().catch((error: unknown) => {
      if (error instanceof AssistantCapacityError && seatAddEnabled && error.capacityLimit?.limitType === "universal") setSeatRefusal(error.capacityLimit);
      else if (error instanceof AssistantCapacityError) setFailure({ kind: "capacity", message: error.message });
      else setFailure({ kind: "generic" });
      setSubmitting(false);
    });
  }, [seatAddEnabled]);
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  }, [submit]);
  const closeSeats = useCallback(() => setSeatRefusal(null), []);
  // An owner's seats count now: create it again.
  const handleSeatsAdded = useCallback(() => {
    setSeatRefusal(null);
    submit();
  }, [submit]);
  const seatNeed: AddSeatsNeed | null = useMemo(() => (seatRefusal ? {
    tenths: 1,
    label: formatMessage({ id: "addSeats.assistant.label" }),
    title: formatMessage({ id: "addSeats.assistant.title" }, {
      count: Math.max(1, Math.ceil((seatTenths(seatRefusal.humans, seatRefusal.agents) + 1) / PRO_AGENT_SEAT_BLOCK_SIZE) - seatRefusal.limit),
    }),
    hint: formatMessage({ id: capabilities.manageBilling ? "addSeats.assistant.hint" : "addSeats.askHint" }, { server: serverName, seats: seatRefusal.limit }),
    resume: formatMessage({ id: "addSeats.assistant.resume" }),
    gate: "seat_limit_agent_create" as const,
  } : null), [capabilities.manageBilling, formatMessage, seatRefusal, serverName]);
  const assistantSeatAsk = useMemo(() => (capabilities.manageBilling || !seatRefusal ? undefined : {
    purpose: { kind: "assistant:create" as const },
    usage: { seats: seatRefusal.limit, humans: seatRefusal.humans, agents: seatRefusal.agents },
  }), [capabilities.manageBilling, seatRefusal]);

  const canDo = [
    formatMessage({ id: "assistant.create.canReadChannels" }),
    formatMessage({ id: "assistant.create.canReadDms" }),
    formatMessage({ id: "assistant.create.canMessageYou" }),
    formatMessage({ id: "assistant.create.canSendAsYou" }),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas" data-testid="assistant-create">
      <PanelHeader
        title={formatMessage({ id: "assistant.title" })}
        onMobileBack={onMobileBack}
        mobileBackProps={MOBILE_BACK_PROPS}
      />
      {/* A form: its fields take focus, so the raft-ui ScrollArea is no tab stop. */}
      <ScrollArea tabIndex={-1} className="flex-1" contentClassName="px-4 py-8 md:py-16 safe-bottom">
        <Card className="mx-auto w-full max-w-md">
          <CardHeader>
            <CardTitle render={<h1>{formatMessage({ id: "assistant.create.title" })}</h1>} />
            <CardDescription>{formatMessage({ id: "assistant.create.description" })}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
              {failure?.kind === "generic" ? (
                <Banner status="warning" size="sm" role="alert" data-testid="assistant-create-error">
                  {formatMessage({ id: "assistant.create.failed" })}
                </Banner>
              ) : null}
              {failure?.kind === "capacity" ? (
                <Banner status="warning" size="sm" role="alert" data-testid="assistant-create-capacity">
                  <BannerDescription>
                    {failure.message}
                    <TextLink variant="strong" className="ml-1" onClick={handleViewPlans} data-testid="assistant-create-view-plans">
                      {formatMessage({ id: "agent.create.viewPlans" })}
                    </TextLink>
                  </BannerDescription>
                </Banner>
              ) : null}
              <div className="grid gap-3 text-callout">
                <ul className="grid gap-2" aria-label={formatMessage({ id: "assistant.create.canLabel" })}>
                  {canDo.map((line) => (
                    <li key={line} className="flex gap-2">
                      <Check size={16} className="mt-0.5 shrink-0 text-success-strong" aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
                disabled={submitting}
                data-testid="assistant-create-submit"
              >
                {formatMessage({ id: submitting ? "assistant.create.submitting" : "assistant.create.submit" })}
              </Button>
            </form>
          </CardContent>
          <CardFooter>
            {formatMessage({ id: "assistant.create.footer" })}
          </CardFooter>
        </Card>
      </ScrollArea>
      {seatNeed && seatRefusal ? (
        <AddSeatsDialog
          need={seatNeed}
          onClose={closeSeats}
          onAdded={handleSeatsAdded}
          ask={assistantSeatAsk}
        />
      ) : null}
    </div>
  );
}
