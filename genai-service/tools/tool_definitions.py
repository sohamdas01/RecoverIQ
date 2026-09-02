MCP_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "attempt_recovery",
            "description": "Retry failed payment immediately via payment gateway",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "Diagnostic reason for immediate retry"}
                },
                "required": ["reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_retry",
            "description": "Schedule an automated retry for a future optimal time window",
            "parameters": {
                "type": "object",
                "properties": {
                    "delayHours": {"type": "integer", "description": "Hours to wait before retrying"},
                    "reason": {"type": "string", "description": "Reason for scheduling retry later"}
                },
                "required": ["delayHours", "reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_recovery_message",
            "description": "Send customer a secure link to the recovery checkout page",
            "parameters": {
                "type": "object",
                "properties": {
                    "channel": {"type": "string", "enum": ["email", "sms", "whatsapp"]},
                    "templateId": {"type": "string"},
                    "customMessage": {"type": "string"}
                },
                "required": ["channel"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "escalate_to_human",
            "description": "Escalate case to merchant risk & operations queue",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string"},
                    "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]}
                },
                "required": ["reason", "priority"]
            }
        }
    }
]
