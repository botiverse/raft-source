import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";

interface GravatarAvatarProps {
  /** Uploaded avatar URL. Takes priority over Gravatar. */
  avatarUrl?: string | null;
  /** Pre-computed SHA-256 hash of the email (from server) */
  gravatarHash?: string | null;
  /** Email to compute hash client-side (for the logged-in user's own avatar) */
  email?: string | null;
  /** Size in pixels for the Gravatar image request */
  size?: number;
  /** Icon size for the fallback User icon */
  iconSize?: number;
}

async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gravatar load/error is an account-level fact for this browser session. Keep it
// outside individual message rows so repeated Thread replies for the same
// person do not each flash the fallback while waiting for their own onLoad.
const loadedGravatarHashes = new Set<string>();
const failedGravatarHashes = new Set<string>();

/**
 * Renders an uploaded human avatar first, then Gravatar for the given hash or email.
 * Falls back to User icon if neither image exists.
 */
export default function GravatarAvatar({ avatarUrl, gravatarHash, email, size = 80, iconSize = 16 }: GravatarAvatarProps) {
  const initialHash = gravatarHash || null;
  const [hash, setHash] = useState<string | null>(initialHash);
  const [uploadedFailed, setUploadedFailed] = useState(false);
  const [failed, setFailed] = useState(() => initialHash ? failedGravatarHashes.has(initialHash) : false);
  // Gravatar is requested with `d=404`, so accounts without a registered
  // Gravatar return HTTP 404. Rendering the <img> first means every such
  // human (the common case — server always derives a gravatarHash from the
  // email, so the placeholder branch below never triggers for members) shows
  // a broken-image box until onError swaps in the User icon. Gate the image
  // behind a successful onLoad: show the clean User placeholder by default
  // and only reveal the Gravatar once it actually loads. (#proj-chat task
  // #33 — regression from #1843 which moved humans onto this path.)
  const [gravatarLoaded, setGravatarLoaded] = useState(() =>
    initialHash ? loadedGravatarHashes.has(initialHash) : false,
  );
  const uploadedAvatarUrl = isRaftUploadedHumanAvatarUrl(avatarUrl) ? avatarUrl : null;

  // Re-resolve gravatar hash when `email`/`gravatarHash` prop changes — a
  // different person (different prop) needs a different gravatar; this is
  // intended. NOT mirror-prop FP family in the harmful sense — the cascading
  // setStates (setHash + setFailed + setGravatarLoaded + setUploadedFailed)
  // are reactive to a new identity. Same family as the async-arrival FPs
  // cleared in PR #2530 / PR #2542. Per @铁根 strategic note msg=2e922c7d,
  // disables listed for all 3 sister rules that fire on this effect.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;

    const applyHash = (nextHash: string | null) => {
      if (cancelled) return;
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setHash(nextHash);
      setFailed(nextHash ? failedGravatarHashes.has(nextHash) : false);
      setGravatarLoaded(nextHash ? loadedGravatarHashes.has(nextHash) : false);
    };

    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setUploadedFailed(false);
    if (gravatarHash) {
      applyHash(gravatarHash);
      return;
    }

    if (!email) {
      applyHash(null);
      return;
    }

    applyHash(null);
    sha256Hex(email.trim().toLowerCase()).then(applyHash);
    return () => { cancelled = true; };
  }, [uploadedAvatarUrl, gravatarHash, email]);

  if (uploadedAvatarUrl && !uploadedFailed) {
    return (
      <img
        src={uploadedAvatarUrl}
        alt=""
        className="h-full w-full object-cover"
        onError={() => setUploadedFailed(true)}
      />
    );
  }

  if (!hash || failed) {
    return <User size={iconSize} />;
  }

  const url = `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;

  // Placeholder stays until the Gravatar actually loads. Keep the probe image
  // mounted but transparent instead of display:none; otherwise identical
  // Gravatar URLs can load inconsistently across repeated message rows.
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {!gravatarLoaded && <User size={iconSize} className="relative z-10" />}
      <img
        src={url}
        alt=""
        className={gravatarLoaded
          ? "absolute inset-0 h-full w-full object-cover"
          : "absolute inset-0 h-full w-full object-cover opacity-0 pointer-events-none"}
        onLoad={() => {
          failedGravatarHashes.delete(hash);
          loadedGravatarHashes.add(hash);
          setGravatarLoaded(true);
        }}
        onError={() => {
          loadedGravatarHashes.delete(hash);
          failedGravatarHashes.add(hash);
          setFailed(true);
        }}
      />
    </div>
  );
}
