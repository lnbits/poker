# Poker

Poker is a WASM LNbits extension for paid, heads-up, best-of-five
Five-Card Draw.

## How a match works

1. The table owner selects a receiving wallet, optional house cut, game name, and seat price.
2. Two players enter Lightning addresses and pay the same seat invoice.
3. Each player receives five private cards. Player 1 acts first in odd-numbered hands and Player 2 acts first in even-numbered hands.
4. Each player may replace zero to three cards. Standard five-card hand rankings determine the winner.
5. A hand winner earns one point. Tied hands earn no points and are replayed.
6. The first player to three points wins the match and receives both seat payments minus the configured cut.

Players can also fold during an active hand. The other player earns that hand's
point, while the Lightning pot remains locked until the match is won.

Tables created before Poker 0.2.0 keep their original single-hand behavior.

## Card privacy and shuffle proof

The shuffled deck, seed, and hands are kept in private extension storage. Public API routes run with the game owner's scoped context, but no public storage policy exposes the secrets table. A player token stored in the URL fragment reveals only that player's cards. Both hands and that hand's original shuffle seed are revealed between hands and when the match ends.

Each hand has a fresh SHA-256 commitment to a seed assembled from two
cryptographically secure host-generated IDs. The revealed seed can be used to
reconstruct the deterministic Fisher-Yates shuffle and verify the commitment.

## Development

From `lnbits/extensions/poker/dev`:

```sh
npm run check
npm run build:wasm
```

No runtime JavaScript dependencies are added by this extension.
