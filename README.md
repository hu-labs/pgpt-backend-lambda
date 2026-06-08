# PromptGPT Backend (AWS Lambda)

The backend for PromptGPT.

A serverless REST API running on AWS Lambda, providing LLM response from OpenAI API.

Designed to serve the frontend , from pgpt-frontend repo.

## Technologies

- **AWS Lambda** for serverless compute
- **API Gateway** for the REST API interface
- **Node.js** runtime
- **Axios** for HTTP client interfacing the OpenAI API
- **AWS Secrets Manager** for security

## Testing

A pre-deployment test can be run manually with:

```bash
npm test
```

But it is intended for GH Actions which couples it with the post-deployment smoke test.
