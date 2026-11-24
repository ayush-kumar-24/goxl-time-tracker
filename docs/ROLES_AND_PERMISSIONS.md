# Roles and permissions

Roles: Super Admin, Founder, Project Admin, Project Lead, PM, Member, Advisor.
Defaults live in `role_permissions`; Super Admin can change them in the Admin panel (`admin_set_permission`).

| Permission | Super Admin | Founder | Project Admin | Project Lead | PM | Member | Advisor |
|---|---|---|---|---|---|---|---|
| addProject | yes | yes | yes | yes | yes | no | no |
| suggestLead | yes | no | yes | no | yes | no | no |
| approveLead | yes | yes | no | no | no | no | no |
| addTask | yes | yes | yes | yes | yes | no | no |
| uploadSheet | yes | yes | yes | yes | yes | no | no |
| setPriority | yes | yes | yes | yes | yes | no | no |
| reassign | yes | yes | yes | yes | yes | no | no |
| uploadDoc | yes | yes | yes | yes | yes | yes | yes |
| viewReports | yes | yes | yes | yes | yes | yes | no |
| founderDash | yes | yes | no | no | no | no | no |
| manageAccess | yes | no | no | no | no | no | no |

Always true: anyone who can see a task can add a dependency; anyone active can run their own timer.

**Project visibility:** Super Admin and Founder see every project. Everyone else sees only projects granted in `project_access`. A project's creator and an approved lead are granted automatically.

**Accounts:** new sign-ups are `pending` and see nothing until a Super Admin sets them `active`. The system refuses to remove or deactivate the last active Super Admin.

## Adding people

Two ways in:

1. **Invitation (Admin screen, Super Admin only).** Record the person's email, name, job title, role and projects with `admin_invite`. When they create an account with that email they are active straight away with that role and those projects. `admin_cancel_invite` withdraws an unused invitation. No email is sent; tell the person which address to use. Super Admin cannot be given by invitation: invite with another role, then promote.
2. **Open sign-up.** Anyone else who creates an account waits as `pending` until a Super Admin approves them.

An invitation trusts the email address, so keep "Confirm email" switched on in Supabase Auth.

## Project-lead flow
1. Project Admin / PM / Super Admin: `suggest_project_lead(project, nominee)`. One open suggestion per project.
2. Founder / Super Admin: `decide_lead_suggestion(id, approve)`.
3. Approval sets `projects.lead_id` and grants the nominee project access. `lead_id` cannot be edited directly.
