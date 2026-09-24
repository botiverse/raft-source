import React from "react";
import { Spinner } from "./ui.js";

export function SpinnerScreen({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="onb-card onb-card--center">
      <Spinner />
      <p className="onb-status-title">{title}</p>
      {description && <p className="onb-status-desc">{description}</p>}
    </div>
  );
}
