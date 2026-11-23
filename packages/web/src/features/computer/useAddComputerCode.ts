import { useCallback, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { normalizeUserCode } from "../../components/auth/deviceLoginApproval";
import { useDeviceLoginApproval } from "../../components/auth/useDeviceLoginApproval";

/**
 * Add Computer's code field: whether it is open, what is typed, and the
 * device login it checks and approves (useDeviceLoginApproval). Held by the
 * dialog, so the field keeps its place and its error while the confirm
 * screen takes the window and after it hands back.
 */
export function useAddComputerCode() {
  const approval = useDeviceLoginApproval();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const { describe, reset } = approval;

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const changeCode = useCallback((event: ChangeEvent<HTMLInputElement>) => setCode(event.target.value), []);
  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const userCode = normalizeUserCode(code);
    // The code goes in the request body only, never in an address.
    if (userCode) void describe({ userCode });
  }, [code, describe]);
  /** Enter a different code: back to an empty, open field. */
  const differentCode = useCallback(() => {
    setCode("");
    setOpen(true);
    reset();
  }, [reset]);

  return { approval, open, toggle, code, changeCode, submit, differentCode };
}

export type AddComputerCode = ReturnType<typeof useAddComputerCode>;
