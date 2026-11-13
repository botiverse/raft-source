export interface PendingInvite {
  id: string;
  invitedEmail: string;
  createdAt: string;
}

export interface JoinLinkRecord {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
}
