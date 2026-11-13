import { useCallback, useState } from "react";
import type { ChangeEvent } from "react";

/** A slug from what was typed: lowercase, anything but letters, digits and hyphens a hyphen. */
export const toServerSlug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/**
 * A new server's name and slug, as Create Server (ServerSelector) and an
 * external invite's "Create a new server" (ExternalInvitePage) take them: the
 * slug follows the name until it is edited itself.
 */
export function useServerNameAndSlug() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const handleNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    if (!slugTouched) setSlug(toServerSlug(e.target.value));
  }, [slugTouched]);

  const handleSlugChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSlugTouched(true);
    setSlug(toServerSlug(e.target.value));
  }, []);

  const reset = useCallback(() => {
    setName("");
    setSlug("");
    setSlugTouched(false);
  }, []);

  return { name, slug, handleNameChange, handleSlugChange, reset };
}
