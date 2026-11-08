data "vultr_os" "ubuntu" {
  filter {
    name   = "name"
    values = ["Ubuntu 24.04 LTS x64"]
  }
}

data "vultr_plan" "selected" {
  filter {
    name   = "id"
    values = [var.plan]
  }
}

resource "vultr_ssh_key" "deploy" {
  name    = "${var.name}-deploy"
  ssh_key = trimspace(var.ssh_public_key)
}

resource "vultr_firewall_group" "web" {
  description = "${var.name}: HTTPS and restricted administrative SSH"
}

resource "vultr_firewall_rule" "web" {
  for_each          = toset(["80", "443"])
  firewall_group_id = vultr_firewall_group.web.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = each.value
  notes             = "ARK public web traffic"
}

resource "vultr_firewall_rule" "ssh" {
  firewall_group_id = vultr_firewall_group.web.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = cidrhost(var.ssh_cidr, 0)
  subnet_size       = tonumber(split("/", var.ssh_cidr)[1])
  port              = "22"
  notes             = "ARK administrator only"
}

resource "vultr_instance" "ark" {
  region            = var.region
  plan              = var.plan
  os_id             = data.vultr_os.ubuntu.id
  label             = var.name
  hostname          = var.name
  ssh_key_ids       = [vultr_ssh_key.deploy.id]
  firewall_group_id = vultr_firewall_group.web.id
  enable_ipv6       = false
  activation_email  = false
  backups           = "disabled"
  tags              = ["ark", "terraform"]
  user_data         = file("${path.module}/cloud-init.yaml")

  depends_on = [vultr_firewall_rule.web, vultr_firewall_rule.ssh]

  lifecycle {
    precondition {
      condition     = contains(data.vultr_plan.selected.locations, var.region)
      error_message = "The selected Vultr plan is not available in this region. Choose another plan or region."
    }
  }
}
