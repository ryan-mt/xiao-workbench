import { useCallback, useState } from "react";

export type LocalUserProfile = {
  name: string;
  avatarDataUrl: string | null;
};

const storageKey = "xiao.user-profile.v1";
const emptyProfile: LocalUserProfile = { name: "", avatarDataUrl: null };

const readProfile = (): LocalUserProfile => {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return emptyProfile;
    const parsed = JSON.parse(stored) as Partial<LocalUserProfile>;
    return {
      name: typeof parsed.name === "string" ? parsed.name.trim() : "",
      avatarDataUrl:
        typeof parsed.avatarDataUrl === "string" && parsed.avatarDataUrl.startsWith("data:image/")
          ? parsed.avatarDataUrl
          : null,
    };
  } catch {
    return emptyProfile;
  }
};

export const profileInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

export function useLocalProfile() {
  const [profile, setProfile] = useState<LocalUserProfile>(readProfile);

  const saveProfile = useCallback((nextProfile: LocalUserProfile) => {
    const normalized = { ...nextProfile, name: nextProfile.name.trim() };
    setProfile(normalized);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(normalized));
    } catch {
      // Keep the profile available for this session when storage is unavailable.
    }
  }, []);

  return { profile, saveProfile };
}
