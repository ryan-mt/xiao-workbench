export type XaiDeviceAuthorization = {
  flowId: string;
  profileId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalSeconds: number;
};

export type XaiOAuthStatus = {
  profileId: string;
  state: "authenticated" | "unauthenticated" | "expired";
  expiresAt: number | null;
  refreshable: boolean;
};

export type XaiOAuthPollResult = {
  state: "pending" | "authorized" | "denied" | "expired";
  retryAfterSeconds: number | null;
  status: XaiOAuthStatus | null;
};
