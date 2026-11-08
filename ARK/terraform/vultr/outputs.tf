output "server_ip" {
  value       = vultr_instance.ark.main_ip
  description = "Public IPv4 address; only 80/443 and allowlisted SSH are exposed."
}

output "instance_id" {
  value = vultr_instance.ark.id
}

output "plan_monthly_usd" {
  value       = data.vultr_plan.selected.monthly_cost
  description = "Current base VM price from the Vultr API; taxes/overages are additional."
}
