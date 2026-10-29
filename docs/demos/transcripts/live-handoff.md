> HOST (T3 delegate_task, not Relay): H thread starts codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":false,"requestKey":"plan-1"}
```

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":true,"requestKey":"plan-1"}
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
