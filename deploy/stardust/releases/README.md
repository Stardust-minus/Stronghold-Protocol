# Private release records

This directory documents the boundary between publishable release tooling and actual operational records. Generated JSON receipts for real environments are not public repository content.

Keep actual release records under ignored `.claude/releases/` or a private off-repository archive. Preserve them before removing a tracked copy; do not delete the only rollback/audit record. Local copies should have restricted permissions.

A private record can bind source revision, image identity, generated-resource and dependency inventories, private/static material versions, host-tool revision, exact admitted process generations, checks performed, failures/skips and rollback materials. Never include secret bodies, cookies or signed URL queries even in a routine evidence record.

Public documentation should explain the procedure using placeholders. Do not publish actual host inventories, management channels, live container IDs, private evidence directories, user authorization history or incident transcripts. Publishing code/docs is not authorization to deploy.

Adding an ignore pattern does not remove already tracked files. A normal deletion commit removes them only from the new tree; previously published history remains. Any history rewrite needs separate explicit authorization and coordination with downstream users.
