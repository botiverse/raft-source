import { REACTION_SPRITE_ITEMS, REACTION_SPRITE_MANIFEST } from "../../generated/reactionSpriteManifest";

interface ReactionGlyphProps {
  emoji: string;
  size: number;
  className?: string;
}

export default function ReactionGlyph({ emoji, size, className = "" }: ReactionGlyphProps) {
  const item = REACTION_SPRITE_ITEMS[emoji];

  if (!item) {
    return <span className={className} style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>;
  }

  const scale = size / item.width;

  return (
    <span
      aria-hidden="true"
      className={className}
      data-reaction-glyph={item.id}
      data-reaction-sprite-path={REACTION_SPRITE_MANIFEST.spritePath}
      style={{
        backgroundImage: `url(${REACTION_SPRITE_MANIFEST.spritePath})`,
        backgroundPosition: `${-item.x * scale}px 0px`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${REACTION_SPRITE_MANIFEST.spriteWidth * scale}px ${REACTION_SPRITE_MANIFEST.spriteHeight * scale}px`,
        display: "inline-block",
        height: size,
        lineHeight: 1,
        width: size,
      }}
    />
  );
}
