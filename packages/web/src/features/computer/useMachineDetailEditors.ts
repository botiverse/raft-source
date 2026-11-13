import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import type { IntlShape } from "react-intl";
import type { Machine, useMachineStore } from "../../store/machineStore";
import { matchesShortcut } from "../shortcuts/dispatcher";

type MachineStoreState = ReturnType<typeof useMachineStore.getState>;

/** The Computer page's Name editor: draft, save, cancel and its keys. */
export function useMachineNameEditor(
  machine: Machine,
  renameMachine: MachineStoreState["renameMachine"],
  formatMessage: IntlShape["formatMessage"],
) {
  const [editingName, setEditingName] = useState(false);
  // draftName is only read while editingName=true. handleStartRename seeds
  // it from machine.name before flipping editingName, so an empty initial
  // value never reaches the rendered input. Initializing with the prop
  // would freeze the mirror on first mount and is what react-doctor's
  // no-derived-useState guards against.
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleStartRename = useCallback(() => {
    setDraftName(machine.name);
    setNameError("");
    setEditingName(true);
  }, [machine.name]);

  const handleSaveRename = useCallback(async () => {
    const nextName = draftName.trim();
    if (!nextName) {
      setNameError(formatMessage({ id: "machine.detail.computerNameRequired" }));
      return;
    }
    if (nextName === machine.name) {
      setEditingName(false);
      setDraftName(machine.name);
      return;
    }
    setNameError("");
    setSavingName(true);
    try {
      await renameMachine(machine.id, nextName);
      setEditingName(false);
    } catch {
      setNameError(formatMessage({ id: "machine.detail.renameComputerFailed" }));
    } finally {
      setSavingName(false);
    }
  }, [draftName, formatMessage, machine.id, machine.name, renameMachine]);
  const handleSaveRenameClick = useCallback(() => {
    void handleSaveRename();
  }, [handleSaveRename]);

  const handleCancelRename = useCallback(() => {
    setDraftName(machine.name);
    setNameError("");
    setEditingName(false);
  }, [machine.name]);

  const handleNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDraftName(e.target.value.replace(/[\r\n]+/g, " "));
    if (nameError) setNameError("");
  }, [nameError]);

  const handleNameKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSaveRename();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancelRename();
    }
  }, [handleCancelRename, handleSaveRename]);

  return {
    editingName,
    draftName,
    savingName,
    nameError,
    nameInputRef,
    handleStartRename,
    handleSaveRenameClick,
    handleCancelRename,
    handleNameChange,
    handleNameKeyDown,
  };
}

/** The Computer page's Description editor: draft, save, cancel and its keys. */
export function useMachineDescriptionEditor(
  machine: Machine,
  updateMachineDetails: MachineStoreState["updateMachineDetails"],
  formatMessage: IntlShape["formatMessage"],
) {
  const [editingDescription, setEditingDescription] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState("");
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  const handleStartEditDescription = useCallback(() => {
    setDraftDescription(machine.description ?? "");
    setDescriptionError("");
    setEditingDescription(true);
  }, [machine.description]);

  const handleSaveDescription = useCallback(async () => {
    const nextDescription = draftDescription.trim();
    if (nextDescription.length > 500) {
      setDescriptionError(formatMessage({ id: "machine.detail.descriptionTooLong" }));
      return;
    }
    const currentDescription = machine.description ?? "";
    if (nextDescription === currentDescription) {
      setEditingDescription(false);
      setDraftDescription(currentDescription);
      return;
    }
    setDescriptionError("");
    setSavingDescription(true);
    try {
      await updateMachineDetails(machine.id, { description: nextDescription || null });
      setEditingDescription(false);
    } catch {
      setDescriptionError(formatMessage({ id: "machine.detail.updateDescriptionFailed" }));
    } finally {
      setSavingDescription(false);
    }
  }, [draftDescription, formatMessage, machine.description, machine.id, updateMachineDetails]);
  const handleSaveDescriptionClick = useCallback(() => {
    void handleSaveDescription();
  }, [handleSaveDescription]);

  const handleCancelDescription = useCallback(() => {
    setDraftDescription(machine.description ?? "");
    setDescriptionError("");
    setEditingDescription(false);
  }, [machine.description]);

  const handleDescriptionChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraftDescription(e.target.value);
    if (descriptionError) setDescriptionError("");
  }, [descriptionError]);

  const handleDescriptionKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchesShortcut(e, "save-computer-description")) {
      e.preventDefault();
      void handleSaveDescription();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancelDescription();
    }
  }, [handleCancelDescription, handleSaveDescription]);

  return {
    editingDescription,
    draftDescription,
    savingDescription,
    descriptionError,
    descriptionInputRef,
    handleStartEditDescription,
    handleSaveDescriptionClick,
    handleCancelDescription,
    handleDescriptionChange,
    handleDescriptionKeyDown,
  };
}
