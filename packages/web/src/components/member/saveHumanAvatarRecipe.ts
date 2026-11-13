import type { HumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";

/**
 * Sets your avatar to a built pixel avatar (PUT /auth/me/avatar-recipe): it
 * replaces any avatar, an uploaded photo too, and the server answers with the
 * updated user, which becomes the signed-in user. Throws when not saved.
 */
export async function saveHumanAvatarRecipe(recipe: HumanAvatarRecipe): Promise<void> {
  const { data } = await api.put("/auth/me/avatar-recipe", { recipe });
  useAuthStore.setState({ user: data });
}
