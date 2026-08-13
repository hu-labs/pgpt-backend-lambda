# PromptGPT Backend (AWS Lambda)

The backend for PromptGPT.

A serverless REST API running on AWS Lambda, providing LLM response from OpenAI API.

Designed to serve the frontend , from pgpt-frontend repo.

## Technologies

- **AWS Lambda** for serverless compute
- **API Gateway** for the REST API interface
- **Node.js 24** runtime using native ES modules and `fetch`
- **AWS Secrets Manager** for security

## Testing

A complete pre-deployment check can be run manually with:

```bash
npm run check
```

This verifies formatting, lint rules, and unit tests. GitHub Actions runs the same check before deployment and follows deployment with a smoke test.
