import type { MessageId } from "../i18n/messages";
export interface BillingControlsStateInput {
  plan?: string | null;
  subscriptionStatus?: "active" | "past_due" | "canceled" | "incomplete" | null;
}

export interface BillingControlsState {
  hasEntitlingSubscription: boolean;
  canCheckout: boolean;
  canUpdatePacks: boolean;
  canOpenPortal: boolean;
}

export interface InternalBillingPlanCopy {
  displayName: MessageId;
  description: MessageId;
  includedFeatures: MessageId[];
}

export interface BillingPlanPresentationInput {
  plan?: string | null;
  displayName?: string | null;
  currentHumanSeats?: number;
  currentAgentSeats?: number;
  currentSeatQuantity?: number;
  proAgentSeatFractionLabel: string;
}

export interface BillingPlanPresentation {
  /** Catalog ids, not display text. Typing these as MessageId makes the mapping
   *  FAIL-CLOSED: a string that is not a catalog key is a compile error, so this
   *  cannot silently fall back to English-source lookup the way billingText did. */
  displayName: MessageId;
  description: MessageId;
  /** ICU arguments for `description`, when it takes any. */
  descriptionValues?: Record<string, string | number>;
  includedFeatures: MessageId[];
  notIncludedFeatures: MessageId[];
  hasProFeatures: boolean;
}

const FREE_INCLUDED_FEATURES: MessageId[] = [
  "billing.channels",
  "billing.tasks",
  "billing.agentsOnYourOwnComputers",
  "billing.agentReminders",
  "billing.basicObservability",
  "billing.30DaysOfMessageHistory",
  "billing.100MbFileUploadsMonth",
  "billing.limitedTimeFreeJointChannel",
];

const FREE_NOT_INCLUDED_FEATURES: MessageId[] = [
  "billing.higherFileUploadLimits",
  "billing.unlimitedMessageHistory",
  "billing.unlimitedJointChannels",
  "billing.moreProfessionalFeaturesComingSoon",
];

const PRO_INCLUDED_FEATURES: MessageId[] = [
  "billing.everythingInFree",
  "billing.unlimitedMessageHistory",
  "billing.higherFileUploadLimits",
  "billing.unlimitedJointChannels",
  "billing.moreProfessionalFeaturesComingSoon",
];

const FOUNDER_INCLUDED_FEATURES: MessageId[] = [
  "billing.everythingWithoutAnyLimitations",
];

const PARTNER_INCLUDED_FEATURES: MessageId[] = [
  "billing.raftFeaturesEnabledForPartnerTestingAndSponsor",
];

export function isInternalBillingPlan(plan?: string | null): boolean {
  return plan === "founder" || plan === "partner";
}

export function getInternalBillingPlanCopy(plan?: string | null): InternalBillingPlanCopy | null {
  if (plan === "founder") {
    return {
      displayName: "billing.founder",
      description: "billing.grandfatheredUnlimitedAccess",
      includedFeatures: FOUNDER_INCLUDED_FEATURES,
    };
  }

  if (plan === "partner") {
    return {
      displayName: "billing.partner",
      description: "billing.partnerAccessForTestingAndSponsoredUse",
      includedFeatures: PARTNER_INCLUDED_FEATURES,
    };
  }

  return null;
}

export function getBillingPlanPresentation(input: BillingPlanPresentationInput): BillingPlanPresentation {
  const plan = input.plan;
  const internalPlanCopy = getInternalBillingPlanCopy(plan);
  if (internalPlanCopy != null) {
    return {
      ...internalPlanCopy,
      notIncludedFeatures: [],
      hasProFeatures: true,
    };
  }

  const isProPlan = plan === "pro";
  const hasProvisionedSeats = (input.currentHumanSeats ?? 0) > 0 || (input.currentAgentSeats ?? 0) > 0;
  if (isProPlan && hasProvisionedSeats) {
    const currentSeatQuantity = input.currentSeatQuantity ?? 0;
    return {
      displayName: "billing.pro",
      // Was a template literal fed to billingText(), an EXACT SOURCE-TEXT lookup,
      // so no key could ever match it. Users did NOT see English here: SettingsPanel
      // carried a hand-written zh fallback beside this call precisely because the
      // lookup could not resolve it. One ICU message replaces both the unresolvable
      // template and that workaround, so the call site's locale branch goes away.
      description: "billing.proSeatsPurchased",
      descriptionValues: {
        count: currentSeatQuantity,
        fraction: input.proAgentSeatFractionLabel,
      },
      includedFeatures: PRO_INCLUDED_FEATURES,
      notIncludedFeatures: [],
      hasProFeatures: true,
    };
  }

  if (isProPlan) {
    return {
      // `input.displayName` is server-supplied text, not a catalog key, so it is
      // deliberately NOT used here: rendering it would put untranslated server
      // text into a localized surface.
      displayName: "billing.pro",
      description: "billing.forBuildersAndTeamsScalingAgentCollaboration",
      includedFeatures: PRO_INCLUDED_FEATURES,
      notIncludedFeatures: [],
      hasProFeatures: true,
    };
  }

  return {
    // Same reason as the Pro branch: `input.displayName` is server-supplied
    // text, not a catalog key.
    displayName: "billing.free",
    description: "billing.startBuildingWithAgents",
    includedFeatures: FREE_INCLUDED_FEATURES,
    notIncludedFeatures: FREE_NOT_INCLUDED_FEATURES,
    hasProFeatures: false,
  };
}

export function getSettingsBillingPlanPresentation(
  plan: string | null | undefined,
  displayName: string | null | undefined,
  currentHumanSeats: number,
  currentAgentSeats: number,
  currentSeatQuantity: number,
  proAgentSeatFractionLabel: string,
): BillingPlanPresentation {
  return getBillingPlanPresentation({
    plan,
    displayName,
    currentHumanSeats,
    currentAgentSeats,
    currentSeatQuantity,
    proAgentSeatFractionLabel,
  });
}

export function getBillingControlsState(input: BillingControlsStateInput): BillingControlsState {
  const hasInternalEntitlement = isInternalBillingPlan(input.plan);
  const hasEntitlingSubscription = !hasInternalEntitlement && (input.subscriptionStatus === "active" || input.subscriptionStatus === "past_due");
  const hasProProjection = input.plan === "pro";
  return {
    hasEntitlingSubscription,
    canCheckout: !hasEntitlingSubscription && !hasInternalEntitlement,
    canUpdatePacks: hasEntitlingSubscription && hasProProjection,
    canOpenPortal: hasEntitlingSubscription,
  };
}
