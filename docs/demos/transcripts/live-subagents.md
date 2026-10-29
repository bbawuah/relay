> HOST (T3 delegate_task, not Relay): H thread starts codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":false,"requestKey":"plan-1"}
```

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":true,"requestKey":"plan-1"}
```

```
$ relay --peer codex-parent send codex-sub 'Answer in one sentence: why must a retry reuse the same request key? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1' --request-key sub-task-1
{"id":"msg-2","state":"stored","duplicate":false,"requestKey":"sub-task-1"}
```

```
$ relay --peer codex-parent inbox
[]
```

> HOST (T3 delegate_task, not Relay): codex-parent starts codex-sub [Codex gpt-6.1-sol]

```
$ relay --peer codex-sub inbox
[{"id":"msg-2","from":"codex-parent","to":"codex-sub","body":"Answer in one sentence: why must a retry reuse the same request key? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1","conversationId":"conv-1"}]
```

```
$ relay --peer codex-sub ack msg-2
{"acknowledged":1}
```

```
$ relay --peer codex-sub ack msg-1
{"acknowledged":0}
```

```
$ relay --peer codex-sub send codex-parent 'A retry must reuse the same request key so Relay recognizes the original request and avoids duplicate delivery; foreign-ack count=0' --request-key sub-1 --conversation conv-1 --reply-to msg-2
{"id":"msg-3","state":"stored","duplicate":false,"requestKey":"sub-1"}
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-3","from":"codex-sub","to":"codex-parent","body":"A retry must reuse the same request key so Relay recognizes the original request and avoids duplicate delivery; foreign-ack count=0","conversationId":"conv-1","replyTo":"msg-2"}]
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-3","from":"codex-sub","to":"codex-parent","body":"A retry must reuse the same request key so Relay recognizes the original request and avoids duplicate delivery; foreign-ack count=0","conversationId":"conv-1","replyTo":"msg-2"}]
```

```
$ relay --peer codex-parent ack msg-3
{"acknowledged":1}
```

> HOST (T3 delegate_task, not Relay): H thread starts claude-parent [Claude claude-sonnet-5-5, effort low]

```
$ relay --peer claude-parent inbox
[{"id":"msg-1","from":"codex-parent","to":"claude-parent","body":"Plan check: name one risk of retrying a send without a request key.","conversationId":"conv-2"}]
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-1","from":"codex-parent","to":"claude-parent","body":"Plan check: name one risk of retrying a send without a request key.","conversationId":"conv-2"}]
```

```
$ relay --peer claude-parent ack msg-1
{"acknowledged":1}
```

```
$ relay --peer claude-parent send claude-sub 'Answer in one sentence: what does a stored receipt from Relay prove, and what does it not prove? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1' --request-key sub-task-1
{"id":"msg-4","state":"stored","duplicate":false,"requestKey":"sub-task-1"}
```

> HOST (T3 delegate_task, not Relay): claude-parent starts claude-sub [Claude claude-sonnet-5-5]

```
$ relay --peer claude-sub inbox
[{"id":"msg-4","from":"claude-parent","to":"claude-sub","body":"Answer in one sentence: what does a stored receipt from Relay prove, and what does it not prove? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1","conversationId":"conv-3"}]
```

```
$ relay --peer claude-sub ack msg-4
{"acknowledged":1}
```

```
$ relay --peer claude-sub ack msg-1
{"acknowledged":0}
```

```
$ relay --peer claude-sub send claude-parent 'A stored receipt proves Relay durably accepted the message into the recipient'\''s mailbox, but not that the recipient read, understood, or acted on it (only an explicit ack shows it was handled); foreign-ack count=0' --request-key sub-1 --conversation conv-3 --reply-to msg-4
{"id":"msg-5","state":"stored","duplicate":false,"requestKey":"sub-1"}
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-5","from":"claude-sub","to":"claude-parent","body":"A stored receipt proves Relay durably accepted the message into the recipient's mailbox, but not that the recipient read, understood, or acted on it (only an explicit ack shows it was handled); foreign-ack count=0","conversationId":"conv-3","replyTo":"msg-4"}]
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-5","from":"claude-sub","to":"claude-parent","body":"A stored receipt proves Relay durably accepted the message into the recipient's mailbox, but not that the recipient read, understood, or acted on it (only an explicit ack shows it was handled); foreign-ack count=0","conversationId":"conv-3","replyTo":"msg-4"}]
```

```
$ relay --peer claude-parent ack msg-5
{"acknowledged":1}
```

```
$ relay --peer claude-parent send codex-parent 'A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.' --request-key plan-reply-1 --conversation conv-2 --reply-to msg-1
{"id":"msg-6","state":"stored","duplicate":false,"requestKey":"plan-reply-1"}
```

> HOST (T3 delegate_task, not Relay): H thread starts a new session of codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent inbox
[{"id":"msg-6","from":"claude-parent","to":"codex-parent","body":"A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.","conversationId":"conv-2","replyTo":"msg-1"}]
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-6","from":"claude-parent","to":"codex-parent","body":"A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.","conversationId":"conv-2","replyTo":"msg-1"}]
```

```
$ relay --peer codex-parent ack msg-6
{"acknowledged":1}
```

```
$ relay --peer codex-parent inbox
[]
```
