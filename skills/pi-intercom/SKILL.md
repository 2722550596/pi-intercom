---
name: pi-intercom
description: |
  Coordinate character agents and story/game processes with pi-intercom.
  Use /connect for duplex chat, send_message for push events,
  and intercom for session discovery and one-off messages.
---

# Pi Intercom Skill (RP Fork)

Use this skill for character ↔ game/story coordination across pi sessions
running on the same machine. Pi-intercom enables duplex agent-to-agent
communication ideal for roleplay setups.

This fork does not include `contact_supervisor` (pi-subagents integration).
It focuses on: `/connect` for natural conversation, `send_message` for
blocking/fire-and-forget pushes.

## When to Use

- **Character ↔ game chat**: Connect a character agent to a story/game process via `/connect`
- **Multi-character scenes**: Several character sessions connected to one game master session
- **Game events to character**: Game pushes a scene, dialogue trigger, or consequence via `send_message`
- **Duplex conversation**: Both sides talk naturally without tool calls
## Core Patterns

### Pattern 1: Character ↔ Game (Duplex)

The signature RP pattern. `/connect` two sessions and talk naturally.

**Setup** (in each terminal):
```
/name story       # terminal 1 - game/story process
/name lian        # terminal 2 - character agent
```

**Connect (from either side):**
```
/connect story    # from character terminal
# OR
/connect lian     # from game terminal
```

Now everything flows automatically:
- Character's dialogue lands as user input in the game session
- Game's narration lands as user input in the character session
- No tools needed — just talk

**Duplex with a one-off message (blocking):**
```typescript
send_message({
  to: "story",
  message: "I draw my sword and step forward."
})
// → Blocks until the game session replies
```

**Fire-and-forget (non-blocking):**
```typescript
send_message({
  to: "lian",
  message: "A cold wind blows through the hall.",
  blocking: false
})
// → Returns immediately, character receives it as a new user message
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected:

```typescript
intercom({ action: "list" })
// → Shows all connected sessions with names, cwd, models, and live status (`idle`, `thinking`, `tool:<name>`)
```

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" })
intercom({ action: "reply", to: "story", message: "The door creaks open. Beyond it, darkness." })
```

`reply` still preserves exact threading under the hood by sending the response with the original `replyTo` value.

### Pattern 4: Broadcast to Multiple Characters

Send the same scene to multiple characters:

```typescript
const characters = ["lian", "kaito", "ember"];
const event = "A distant roar shakes the ground.";
// Fire-and-forget to all characters
characters.forEach(c => 
  intercom({ action: "send", to: c, message: event })
);
```

### Pattern 5: Send with Attachments

Share code snippets, files, or context:

```typescript
intercom({
  action: "send",
  to: "story",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget | You don't need a response |
| `ask` | Blocks until reply (10 min timeout) | You need an answer to continue |
| `reply` | Responds to the active or pending inbound ask | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `list` | Returns all sessions with live status | You need to discover targets or choose an idle peer |
| `status` | Returns your connection state | Troubleshooting |

## Optional: Visible Peer Sessions via cmux or tmux

For RP scenarios where you want both sessions side by side.

```bash
# cmux: split and launch a character session in the right pane
cmux new-split right
sleep 0.5
cmux send --surface right '/name kaito && pi'
```

Then `/connect` from either side to establish the duplex channel.

## Important Constraints

### `ask` Limitations

- **10-minute timeout**: If no reply comes within 10 minutes, the ask fails
- **One at a time**: Cannot have multiple pending asks from the same session
- **Cannot self-target**: A session cannot ask itself

```typescript
// Check if already waiting before asking
const result = await intercom({ action: "ask", to: "story", message: "..." });
if (result.isError && result.content[0].text.includes("Already waiting")) {
  // Use send instead, or wait for current ask to complete
}
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions show a confirmation dialog
- **Replies skip confirmation**: Messages with `replyTo` never show confirmation dialogs

## Best Practices

### Use `ask` for blocking messages

When the game needs the character's response:

```typescript
const reply = await intercom({
  action: "ask",
  to: "lian",
  message: "The old merchant eyes you suspiciously. 'And what business does a stranger have in Thornwood?'"
});
// Continue with the character's reply...
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "story",
  message: "I open the chest carefully, checking for traps."
});
// Continue immediately, don't wait
```

### Include reply hints in messages

Make it easy for recipients to respond:

```typescript
// GOOD: Recipient sees exact command to reply
intercom({
  action: "send",
  to: "lian",
  message: `Found the issue in auth.ts:142. Use getUserById() instead of getUser().

Reply with: intercom({ action: "reply", message: "..." })`
});
```

Use `/name` so others can target you easily:

```
/name lian      # Character name
/name story     # Game/story process
/name gm        # Game master
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a reply"**
```typescript
// You can only have one pending ask at a time
// Option 1: Use send instead
intercom({ action: "send", to: "story", message: "..." });

// Option 2: Wait for current ask to complete first
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom({ action: "send", to: "lian", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom({ action: "list" });
}
```

**Ask timeout (after 10 minutes)**
```typescript
// The ask will reject with a timeout error
// Design your workflow so answers come within 10 minutes
// For longer tasks, use send + follow-up ask pattern
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom({ action: "status" })`
2. Verify the target session has loaded pi-intercom
3. Ensure both sessions are on the same machine (intercom is same-machine only)

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "lian", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently disconnected:

```typescript
intercom({ action: "status" })
// Check if broker is running and restart if needed
```

## Common Workflows (RP)

### Game Pushes Scene to Character

```typescript
send_message({
  to: "lian",
  message: "Dawn breaks over the crumbling village. Smoke rises from a burning
  watchtower. A rider gallops toward you, his face pale with fear."
})
// → Character receives it as a new user message and responds in-character
```

### Character Inquires About Surroundings

```typescript
send_message({
  to: "story",
  message: "I scan the rooftops. Is anyone watching us?"
})
// → Game responds with the scene state
```

### Multi-Character Scene (Via Duplex)

```
# Terminal 1: /name gm         # Terminal 2: /name lian    # Terminal 3: /name kaito
# GM connects to both:
/connect lian
/connect kaito
# GM speaks once → both characters hear it as user input
# Characters reply → GM sees their responses
```

### Combat Event (Fire-and-Forget)

```typescript
send_message({
  to: "lian",
  message: "A goblin arrow whizzes past your ear. Roll for initiative.",
  blocking: false
})
// → Character receives it but doesn't need to respond immediately
```
