mock_provider "vultr" {
  mock_data "vultr_os" {
    defaults = { id = "1743" }
  }
  mock_data "vultr_plan" {
    defaults = {
      locations    = ["ewr"]
      monthly_cost = 24
    }
  }
}

run "restricted_network" {
  command = plan
  variables {
    name           = "ark-test"
    region         = "ewr"
    plan           = "vc2-2c-4gb"
    ssh_cidr       = "203.0.113.10/32"
    ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyForMockedProviderOnly"
  }
  assert {
    condition     = vultr_firewall_rule.ssh.subnet_size == 32 && vultr_firewall_rule.ssh.subnet == "203.0.113.10"
    error_message = "SSH must be restricted to the administrator CIDR."
  }
  assert {
    condition     = toset([for rule in vultr_firewall_rule.web : rule.port]) == toset(["80", "443"])
    error_message = "Only HTTP/HTTPS may be publicly exposed."
  }
  assert {
    condition     = !vultr_instance.ark.enable_ipv6 && vultr_instance.ark.backups == "disabled"
    error_message = "Unexpected IPv6 exposure or chargeable add-on."
  }
  assert {
    condition     = !strcontains(vultr_instance.ark.user_data, "API_KEY=") && !strcontains(vultr_instance.ark.user_data, "ARK_PROXY_TOKEN=")
    error_message = "Application credentials must not enter cloud-init/state."
  }
}
