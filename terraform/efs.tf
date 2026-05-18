# -----------------------------------------------------------------------------
# EFS for the embedder model cache.
#
# Without persistent storage, every cold-start embedder task re-downloads
# the ~30 MB bge-small model from Hugging Face — slow and rate-limit-risky.
# EFS lets us share a warm cache across replicas and across restarts.
#
# The access point pins ownership to UID/GID 1001, matching the
# `node-embedder` user baked into apps/embedder/Dockerfile, so files written
# through the access point are owned correctly.
# -----------------------------------------------------------------------------

resource "aws_efs_file_system" "embedder_models" {
  creation_token = "${var.name_prefix}-embedder-models"
  encrypted      = true

  # General Purpose performance mode + bursting throughput is plenty for a
  # ~30 MB read-mostly cache. Don't pay for provisioned throughput.
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  tags = merge(local.tags, { Name = "${var.name_prefix}-embedder-models" })
}

# One mount target per private subnet so any AZ the embedder lands in can
# reach the file system.
resource "aws_efs_mount_target" "embedder_models" {
  for_each = toset(var.private_subnet_ids)

  file_system_id  = aws_efs_file_system.embedder_models.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

# Access point gives the embedder task a chrooted view of the file system,
# with files always owned by uid/gid 1001 regardless of which task wrote
# them. Matches the `node-embedder` user in the Dockerfile.
resource "aws_efs_access_point" "embedder_models" {
  file_system_id = aws_efs_file_system.embedder_models.id

  posix_user {
    uid = 1001
    gid = 1001
  }

  root_directory {
    path = "/models"

    creation_info {
      owner_uid   = 1001
      owner_gid   = 1001
      permissions = "0755"
    }
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-embedder-models" })
}
